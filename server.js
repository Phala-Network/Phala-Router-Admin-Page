"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

const port = Number(process.env.PORT || "8080");
const basicUser = process.env.BASIC_AUTH_USER || "";
const basicPasswordHash = process.env.BASIC_AUTH_PASSWORD_SHA256 || "";
const redpillAPIURL = normalizedBaseURL(process.env.REDPILL_API_URL || "https://service.redpill.ai");
const redpillAPIKey = process.env.REDPILL_API_KEY || "";
const privateAIControlURL = normalizedBaseURL(process.env.PRIVATE_AI_CONTROL_URL || "");
const redpillWebURL = normalizedBaseURL(process.env.REDPILL_WEB_URL || "");
const redpillWebRevalidateToken = process.env.REDPILL_WEB_REVALIDATE_TOKEN || "";
const requestTimeoutMs = Number(process.env.REDPILL_REQUEST_TIMEOUT_MS || "15000");
const pigRequestTimeoutMs = Number(process.env.PIG_REQUEST_TIMEOUT_MS || "2500");
const bodyLimitBytes = Number(process.env.ADMIN_BODY_LIMIT_BYTES || String(1024 * 1024));
const syncAfterWriteDefault = process.env.REDPILL_SYNC_AFTER_WRITE !== "false";
const modelCacheTtlMs = Number(process.env.REDPILL_MODEL_CACHE_TTL_MS || "300000");
const deploymentCacheTtlMs = Number(process.env.REDPILL_DEPLOYMENT_CACHE_TTL_MS || "300000");
const pigMetricsCacheTtlMs = Number(process.env.PIG_METRICS_CACHE_TTL_MS || "1200");
const pigMetricsStaleTtlMs = Number(process.env.PIG_METRICS_STALE_TTL_MS || "60000");
const pigMetricsPath = process.env.PIG_METRICS_PATH || "/pig/metrics";
const pigPolicyPath = process.env.PIG_POLICY_PATH || "/admin/v1/predictive-policy";
const pigPolicyBodyLimit = Number(process.env.PIG_POLICY_BODY_LIMIT_BYTES || "4096");
const pigAdminToken = process.env.PIG_ADMIN_TOKEN || process.env.GATEWAY_ADMIN_TOKEN || process.env.PHALA_NODE_BEARER_TOKEN || "";
const phalaProviders = splitList(process.env.REDPILL_PHALA_PROVIDERS || "phala").map((value) => value.toLowerCase());
const phalaHostSuffixes = splitList(process.env.REDPILL_PHALA_HOST_SUFFIXES || "phala.com").map((value) => value.toLowerCase());
const staticRoot = path.join(__dirname, "public");

const modelCache = { at: 0, value: null, promise: null };
const deploymentCache = new Map();
const pigMetricsCache = new Map();

class HTTPError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function splitList(value) {
  return String(value || "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizedBaseURL(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function timingEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function authorized(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;
  let decoded = "";
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }
  const split = decoded.indexOf(":");
  if (split < 0) return false;
  const user = decoded.slice(0, split);
  const pass = decoded.slice(split + 1);
  const hash = crypto.createHash("sha256").update(pass).digest("hex");
  return timingEqual(user, basicUser) && timingEqual(hash, basicPasswordHash);
}

function requireAuth(req, res) {
  if (authorized(req)) return true;
  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="Phala Node Admin"',
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end("authentication required\n");
  return false;
}

function sendJSON(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(value));
}

function sendText(res, status, text, contentType) {
  res.writeHead(status, {
    "Content-Type": contentType || "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(text);
}

function errorMessage(err) {
  return String(err && err.message ? err.message : err);
}

function errorStatus(err) {
  if (err instanceof HTTPError) return err.status;
  return 502;
}

function sendError(res, err) {
  const status = errorStatus(err);
  const payload = { error: errorMessage(err) };
  if (err instanceof HTTPError && err.details !== undefined) payload.details = err.details;
  sendJSON(res, status, payload);
}

function requireRedpillConfig() {
  if (!redpillAPIURL) throw new HTTPError(500, "REDPILL_API_URL is not configured");
  if (!redpillAPIKey) throw new HTTPError(500, "REDPILL_API_KEY is not configured");
}

function compactUpstreamError(text) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  return raw.length > 1200 ? `${raw.slice(0, 1200)}...` : raw;
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath);
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function serveStatic(req, res, pathname) {
  let decoded = "";
  try {
    decoded = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  } catch {
    sendText(res, 400, "bad path\n");
    return;
  }
  const resolved = path.resolve(staticRoot, "." + decoded);
  if (!resolved.startsWith(staticRoot + path.sep)) {
    sendText(res, 403, "forbidden\n");
    return;
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      sendText(res, 404, "not found\n");
      return;
    }
    res.writeHead(200, {
      "Content-Type": contentTypeFor(resolved),
      "Cache-Control": "no-store"
    });
    res.end(data);
  });
}

function readBody(req, limit = bodyLimitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new HTTPError(413, `request body exceeds ${limit} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJSON(req, limit = bodyLimitBytes) {
  const body = await readBody(req, limit);
  try {
    const parsed = JSON.parse(body.toString("utf8") || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("body must be a JSON object");
    }
    return parsed;
  } catch (err) {
    throw new HTTPError(400, `invalid JSON body: ${errorMessage(err)}`);
  }
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || requestTimeoutMs);
  try {
    const requestOptions = { ...options, signal: controller.signal };
    delete requestOptions.timeoutMs;
    return await fetch(url, requestOptions);
  } finally {
    clearTimeout(timeout);
  }
}

async function requestJSON(url, options = {}) {
  const response = await fetchWithTimeout(url, options);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const message = typeof data === "string" ? compactUpstreamError(data) : JSON.stringify(data);
    throw new HTTPError(response.status >= 400 && response.status < 500 ? response.status : 502, `HTTP ${response.status}: ${message}`);
  }
  return data;
}

async function redpillRequest(method, requestPath, body) {
  requireRedpillConfig();
  const headers = {
    "X-API-Key": redpillAPIKey,
    Accept: "application/json"
  };
  const options = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  return requestJSON(redpillAPIURL + requestPath, options);
}

function cacheFresh(entry, ttlMs) {
  return entry && ttlMs > 0 && Date.now() - entry.at <= ttlMs;
}

function boolFromSearch(url, name, defaultValue) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return defaultValue;
  return raw === "1" || raw === "true" || raw === "yes";
}

function normalizeModel(model) {
  const specs = model.specs && typeof model.specs === "object" ? model.specs : {};
  return {
    id: model.id,
    model_id: model.model_id,
    name: model.name || model.model_id,
    active: Boolean(model.active),
    context_length: model.context_length ?? specs.context_length ?? null,
    is_tee: specs.is_tee ?? null,
    input_cost_per_token: specs.input_cost_per_token ?? null,
    output_cost_per_token: specs.output_cost_per_token ?? null,
    supported_parameters: Array.isArray(specs.supported_parameters) ? specs.supported_parameters : [],
    input_modalities: Array.isArray(specs.input_modalities) ? specs.input_modalities : []
  };
}

function normalizeDeployment(deployment) {
  const config = deployment.config && typeof deployment.config === "object" ? deployment.config : {};
  return {
    id: deployment.id,
    model_id: deployment.model_id,
    model_string_id: deployment.model_string_id,
    provider: deployment.provider,
    provider_name: deployment.provider_name,
    deployment_name: deployment.deployment_name,
    active: Boolean(deployment.active),
    base_url: config.base_url || deployment.base_url || "",
    weight: config.weight ?? deployment.weight ?? null,
    has_api_key: config.has_api_key ?? null,
    input_cost_per_token: config.input_cost_per_token ?? null,
    output_cost_per_token: config.output_cost_per_token ?? null,
    cache_read_cost_per_token: config.cache_read_cost_per_token ?? null,
    cache_creation_cost_per_token: config.cache_creation_cost_per_token ?? null,
    capabilities: config.capabilities || {},
    created_at: deployment.created_at,
    updated_at: deployment.updated_at
  };
}

function lowerProviderFields(deployment) {
  return [deployment.provider, deployment.provider_name]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
}

function hostFromEndpoint(value) {
  try {
    const raw = String(value || "");
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isPhalaHost(value) {
  const host = hostFromEndpoint(value);
  if (!host) return false;
  return phalaHostSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function isPhalaDeployment(deployment) {
  const providers = lowerProviderFields(deployment);
  return providers.some((provider) => phalaProviders.includes(provider)) || isPhalaHost(deployment.base_url);
}

function phalaOnly(deployments) {
  return deployments.filter(isPhalaDeployment);
}

async function fetchModels(force = false) {
  if (!force && cacheFresh(modelCache, modelCacheTtlMs)) return modelCache.value;
  if (!force && modelCache.promise) return modelCache.promise;
  const promise = redpillRequest("GET", "/api/admin/models?include_inactive=true")
    .then((models) => {
      const normalized = (Array.isArray(models) ? models : []).map(normalizeModel);
      modelCache.value = normalized;
      modelCache.at = Date.now();
      modelCache.promise = null;
      return normalized;
    })
    .catch((err) => {
      modelCache.promise = null;
      throw err;
    });
  modelCache.promise = promise;
  return promise;
}

function filterModels(models, query, activeFilter) {
  const needle = String(query || "").trim().toLowerCase();
  return models.filter((model) => {
    if (activeFilter === "active" && !model.active) return false;
    if (activeFilter === "inactive" && model.active) return false;
    if (!needle) return true;
    return [model.model_id, model.name, model.id].some((value) => String(value || "").toLowerCase().includes(needle));
  });
}

async function listModels(url) {
  const force = boolFromSearch(url, "force", false);
  const query = url.searchParams.get("q") || "";
  const activeFilter = url.searchParams.get("active") || "all";
  const models = await fetchModels(force);
  return {
    models: filterModels(models, query, activeFilter),
    generated_at: new Date().toISOString(),
    cache: {
      age_seconds: Math.max(0, Math.round((Date.now() - modelCache.at) / 1000)),
      ttl_seconds: Math.round(modelCacheTtlMs / 1000)
    }
  };
}

async function fetchDeployments(modelID, force = false) {
  if (!Number.isInteger(modelID) || modelID <= 0) throw new HTTPError(400, "model id must be a positive integer");
  const cached = deploymentCache.get(modelID);
  if (!force && cacheFresh(cached, deploymentCacheTtlMs)) return cached.value;
  if (!force && cached?.promise) return cached.promise;
  const promise = redpillRequest("GET", `/api/admin/models/${modelID}/deployments?include_inactive=true`)
    .then((deployments) => {
      const normalized = (Array.isArray(deployments) ? deployments : [])
        .map(normalizeDeployment)
        .sort((a, b) => Number(a.id) - Number(b.id));
      deploymentCache.set(modelID, { value: normalized, at: Date.now(), promise: null });
      return normalized;
    })
    .catch((err) => {
      if (cached) deploymentCache.set(modelID, { ...cached, promise: null });
      throw err;
    });
  deploymentCache.set(modelID, { ...(cached || {}), promise });
  return promise;
}

function updateDeploymentCache(modelID, updated) {
  const normalized = normalizeDeployment(updated);
  const cached = deploymentCache.get(modelID);
  if (!cached?.value) return normalized;
  deploymentCache.set(modelID, {
    value: cached.value.map((item) => Number(item.id) === Number(normalized.id) ? normalized : item).sort((a, b) => Number(a.id) - Number(b.id)),
    at: Date.now(),
    promise: null
  });
  return normalized;
}

async function listDeployments(modelID, force = false) {
  const deployments = await fetchDeployments(modelID, force);
  const phalaDeployments = phalaOnly(deployments);
  const cached = deploymentCache.get(modelID);
  return {
    model_id: modelID,
    deployments: phalaDeployments,
    all_deployment_count: deployments.length,
    hidden_non_phala_count: deployments.length - phalaDeployments.length,
    generated_at: new Date().toISOString(),
    cache: cached ? {
      age_seconds: Math.max(0, Math.round((Date.now() - cached.at) / 1000)),
      ttl_seconds: Math.round(deploymentCacheTtlMs / 1000)
    } : null
  };
}

async function requireManagedDeployment(modelID, deploymentID) {
  let deployments = await fetchDeployments(modelID, false);
  let deployment = deployments.find((item) => Number(item.id) === Number(deploymentID));
  if (!deployment) {
    deployments = await fetchDeployments(modelID, true);
    deployment = deployments.find((item) => Number(item.id) === Number(deploymentID));
  }
  if (!deployment) throw new HTTPError(404, `deployment not found: ${deploymentID}`);
  if (!isPhalaDeployment(deployment)) throw new HTTPError(403, "only Phala deployments can be managed here");
  return deployment;
}

function modelIDFromInput(input) {
  const modelID = Number(input.model_id);
  if (!Number.isInteger(modelID) || modelID <= 0) throw new HTTPError(400, "model_id must be a positive integer");
  return modelID;
}

function shouldSync(input) {
  if (!Object.prototype.hasOwnProperty.call(input, "sync_after_write")) return syncAfterWriteDefault;
  return input.sync_after_write !== false;
}

async function maybeWithSync(input, payload) {
  if (!shouldSync(input)) return { ...payload, sync: null };
  return { ...payload, sync: await propagateAll() };
}

async function setDeploymentActive(req, deploymentID) {
  const input = await readJSON(req);
  const modelID = modelIDFromInput(input);
  const current = await requireManagedDeployment(modelID, deploymentID);
  if (typeof input.active !== "boolean") throw new HTTPError(400, "active must be boolean");
  if (current.active === input.active) {
    return maybeWithSync({ ...input, sync_after_write: false }, {
      deployment: current,
      changed: false,
      deployments: phalaOnly(await fetchDeployments(modelID, false))
    });
  }
  const updated = updateDeploymentCache(modelID, await redpillRequest("PATCH", `/api/admin/deployments/${deploymentID}/active`, { active: input.active }));
  return maybeWithSync(input, {
    deployment: updated,
    changed: true,
    deployments: phalaOnly(await fetchDeployments(modelID, false))
  });
}

async function bulkSetDeploymentActive(req) {
  const input = await readJSON(req);
  const modelID = modelIDFromInput(input);
  if (typeof input.active !== "boolean") throw new HTTPError(400, "active must be boolean");
  if (!Array.isArray(input.deployment_ids) || input.deployment_ids.length === 0) {
    throw new HTTPError(400, "deployment_ids must be a non-empty array");
  }
  const ids = input.deployment_ids.map((id) => Number(id));
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new HTTPError(400, "deployment_ids must contain positive integers");
  }

  const deployments = await fetchDeployments(modelID, false);
  const results = [];
  for (const id of ids) {
    const current = deployments.find((deployment) => Number(deployment.id) === id);
    if (!current) throw new HTTPError(404, `deployment not found: ${id}`);
    if (!isPhalaDeployment(current)) throw new HTTPError(403, `only Phala deployments can be managed here: ${id}`);
    if (current.active === input.active) {
      results.push({ id, changed: false, active: current.active, action: input.active ? "already_active" : "already_inactive" });
      continue;
    }
    const updated = updateDeploymentCache(modelID, await redpillRequest("PATCH", `/api/admin/deployments/${id}/active`, { active: input.active }));
    current.active = updated.active;
    results.push({ id, changed: true, active: updated.active, action: input.active ? "activated" : "deactivated" });
  }
  const changed = results.some((result) => result.changed);
  const sync = changed && shouldSync(input) ? await propagateAll() : null;
  return {
    model_id: modelID,
    active: input.active,
    results,
    sync,
    deployments: phalaOnly(await fetchDeployments(modelID, false))
  };
}

async function propagateAll() {
  const preview = await gatewayPreviewSummary();
  if (preview.error_count > 0) {
    throw new HTTPError(409, "gateway preview has errors; refusing to sync", preview);
  }
  const syncRaw = await redpillRequest("POST", "/api/admin/gateway-upstreams/sync", {});
  const sync = {
    upstream_count: syncRaw.upstream_count ?? null,
    route_count: syncRaw.route_count ?? null,
    config_digest: syncRaw.config_digest ?? null,
    generated_at: syncRaw.generated_at ?? null
  };
  const [control, web] = await Promise.all([refreshControlCache(), refreshWebCache()]);
  return { preview, sync, control, web };
}

async function refreshControlCache() {
  if (!privateAIControlURL) return { skipped: true, reason: "PRIVATE_AI_CONTROL_URL is not configured" };
  const keyHash = crypto.createHash("sha256").update(redpillAPIKey).digest("hex");
  const data = await requestJSON(privateAIControlURL + "/admin/cache/refresh", {
    method: "POST",
    headers: {
      "X-API-Key-Hash": keyHash,
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0"
    },
    body: "{}"
  });
  return {
    skipped: false,
    success: Boolean(data && data.success),
    cleared: data && data.cleared
  };
}

async function refreshWebCache() {
  if (!redpillWebURL || !redpillWebRevalidateToken) {
    return { skipped: true, reason: "REDPILL_WEB_URL or REDPILL_WEB_REVALIDATE_TOKEN is not configured" };
  }
  const data = await requestJSON(redpillWebURL + "/api/revalidate", {
    method: "POST",
    headers: {
      "X-Revalidate-Token": redpillWebRevalidateToken,
      "Content-Type": "application/json",
      "User-Agent": "redpill-node-admin/1.0"
    }
  });
  return {
    skipped: false,
    revalidated: Boolean(data && data.revalidated),
    paths: data && data.paths,
    tags: data && data.tags
  };
}

async function gatewayPreviewSummary() {
  const preview = await redpillRequest("GET", "/api/admin/gateway-upstreams/preview");
  return {
    generated_at: preview.generated_at || null,
    upstream_count: Array.isArray(preview.upstreams) ? preview.upstreams.length : preview.upstream_count ?? null,
    route_count: Array.isArray(preview.routes) ? preview.routes.length : preview.route_count ?? null,
    error_count: Array.isArray(preview.errors) ? preview.errors.length : 0,
    errors: Array.isArray(preview.errors) ? preview.errors : []
  };
}

function normalizeEndpoint(value, appendV1 = true) {
  let raw = String(value || "").trim();
  if (!raw) throw new HTTPError(400, "base_url is required");
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new HTTPError(400, `invalid base_url: ${value}`);
  }
  if (!url.hostname) throw new HTTPError(400, `invalid base_url: ${value}`);
  url.hash = "";
  url.search = "";
  if (appendV1 && (url.pathname === "" || url.pathname === "/")) url.pathname = "/v1";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/+$/, "");
}

function pigBaseURL(value) {
  const normalized = normalizeEndpoint(value, false);
  const url = new URL(normalized);
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function parsePrometheus(text) {
  const samples = [];
  for (const raw of String(text || "").split(/\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([^\s{]+)(?:\{([^}]*)\})?\s+([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?|NaN|Inf|-Inf)$/);
    if (!match) continue;
    const labels = {};
    if (match[2]) {
      for (const item of match[2].split(",")) {
        const part = item.trim();
        if (!part) continue;
        const eq = part.indexOf("=");
        if (eq <= 0) continue;
        labels[part.slice(0, eq).trim()] = part.slice(eq + 1).trim().replace(/^"|"$/g, "");
      }
    }
    const value = Number(match[3]);
    if (!Number.isFinite(value)) continue;
    samples.push({ name: match[1], labels, value });
  }
  return samples;
}

function firstSample(samples, name) {
  return samples.find((sample) => sample.name === name) || null;
}

function firstMetric(samples, name, labelKey, labelValue) {
  for (const sample of samples) {
    if (sample.name !== name) continue;
    if (labelKey && sample.labels[labelKey] !== labelValue) continue;
    return sample.value;
  }
  return null;
}

function labelValue(samples, name, key) {
  const sample = firstSample(samples, name);
  return sample ? sample.labels[key] || "" : "";
}

function nearLimit(value, limit) {
  const v = Number(value);
  const l = Number(limit);
  return Number.isFinite(v) && Number.isFinite(l) && l > 0 && (v >= l || v * 100 >= l * 85);
}

function pigStatus(metrics) {
  if (!metrics.ok) return "error";
  if (metrics.waiting > 0 || metrics.queue_current > 0 || metrics.state === "red" || (metrics.backend_count > 0 && metrics.backend_failed >= metrics.backend_count)) {
    return "red";
  }
  if (nearLimit(metrics.running, metrics.global_limit) || nearLimit(metrics.basic_inflight, metrics.basic_limit)) return "yellow";
  if (metrics.state === "yellow") return "yellow";
  return "green";
}

function parsePigMetrics(text) {
  const samples = parsePrometheus(text);
  const metrics = {
    ok: true,
    version: labelValue(samples, "pig_version_info", "version") || null,
    state: labelValue(samples, "pig_dynamic_state_info", "state") || null,
    source: labelValue(samples, "pig_dynamic_state_info", "source") || null,
    running: firstMetric(samples, "pig_dynamic_observed_running") ?? firstMetric(samples, "pig_inflight", "lane", "global"),
    waiting: firstMetric(samples, "pig_dynamic_observed_waiting") ?? firstMetric(samples, "pig_queue_current"),
    queue_current: firstMetric(samples, "pig_queue_current"),
    global_limit: firstMetric(samples, "pig_dynamic_global_limit"),
    hard_global_limit: firstMetric(samples, "pig_dynamic_hard_global_limit"),
    admission_limit: firstMetric(samples, "pig_dynamic_admission_limit"),
    capacity_limit: firstMetric(samples, "pig_dynamic_capacity_limit"),
    pressure_limit: firstMetric(samples, "pig_dynamic_pressure_limit"),
    prefill_limit: firstMetric(samples, "pig_dynamic_prefill_limit"),
    basic_limit: firstMetric(samples, "pig_tier_basic_limit"),
    basic_inflight: firstMetric(samples, "pig_tier_inflight", "tier", "basic"),
    premium_inflight: firstMetric(samples, "pig_tier_inflight", "tier", "premium"),
    basic_waiting: firstMetric(samples, "pig_tier_waiting", "tier", "basic"),
    premium_waiting: firstMetric(samples, "pig_tier_waiting", "tier", "premium"),
    generation_tps: firstMetric(samples, "pig_dynamic_observed_generation_tokens_per_second"),
    user_tps: firstMetric(samples, "pig_dynamic_observed_single_user_tokens_per_second"),
    ttft_p95_seconds: firstMetric(samples, "pig_dynamic_observed_ttft_p95_seconds"),
    ttft_p99_seconds: firstMetric(samples, "pig_dynamic_observed_ttft_p99_seconds"),
    kv_cache_usage: firstMetric(samples, "pig_dynamic_observed_kv_cache_usage"),
    capacity_safe_limit: firstMetric(samples, "pig_dynamic_capacity_safe_limit"),
    capacity_projected_limit: firstMetric(samples, "pig_dynamic_capacity_projected_limit"),
    capacity_learned_limit: firstMetric(samples, "pig_dynamic_capacity_learned_limit"),
    capacity_target_limit: firstMetric(samples, "pig_dynamic_capacity_target_limit"),
    ttft_limit: firstMetric(samples, "pig_dynamic_ttft_limit"),
    rejected_total: firstMetric(samples, "pig_rejected_total"),
    dynamic_rejected_total: firstMetric(samples, "pig_dynamic_rejected_total"),
    backend_count: firstMetric(samples, "pig_dynamic_backend_count") ?? firstMetric(samples, "pig_backend_count"),
    backend_failed: firstMetric(samples, "pig_dynamic_backend_failed"),
    updated_unix_seconds: firstMetric(samples, "pig_dynamic_last_update_seconds")
  };
  metrics.status = pigStatus(metrics);
  metrics.sample_count = samples.length;
  return metrics;
}

function metricsUnavailable(message, status = "error") {
  return {
    ok: false,
    status,
    error: message
  };
}

function decoratePigMetrics(metrics, freshness, sampledAt, sourceError) {
  const ageSeconds = Math.max(0, Math.round((Date.now() - sampledAt) / 1000));
  const out = {
    ...metrics,
    freshness,
    stale: freshness === "stale",
    sampled_at: new Date(sampledAt).toISOString(),
    age_seconds: ageSeconds
  };
  if (sourceError) out.source_error = sourceError;
  return out;
}

function stalePigMetrics(key, message) {
  const cached = pigMetricsCache.get(key);
  if (cacheFresh(cached, pigMetricsStaleTtlMs)) {
    return decoratePigMetrics(cached.metrics, "stale", cached.at, message);
  }
  return metricsUnavailable(message);
}

async function fetchPigMetrics(baseURL, force = false) {
  const base = pigBaseURL(baseURL);
  const cached = pigMetricsCache.get(base);
  if (!force && cacheFresh(cached, pigMetricsCacheTtlMs)) {
    return decoratePigMetrics(cached.metrics, "fresh", cached.at);
  }
  if (!pigAdminToken) return metricsUnavailable("PIG_ADMIN_TOKEN is not configured");
  try {
    const response = await fetchWithTimeout(base + pigMetricsPath, {
      headers: {
        Authorization: `Bearer ${pigAdminToken}`,
        Accept: "text/plain"
      },
      timeoutMs: pigRequestTimeoutMs
    });
    const text = await response.text();
    if (!response.ok) return stalePigMetrics(base, `HTTP ${response.status}: ${compactUpstreamError(text)}`);
    const parsed = parsePigMetrics(text);
    const sampledAt = Date.now();
    pigMetricsCache.set(base, { metrics: parsed, at: sampledAt });
    return decoratePigMetrics(parsed, "fresh", sampledAt);
  } catch (err) {
    return stalePigMetrics(base, errorMessage(err));
  }
}

async function pigSnapshot(url) {
  const modelID = Number(url.searchParams.get("model_id"));
  const force = boolFromSearch(url, "force", false);
  if (!Number.isInteger(modelID) || modelID <= 0) throw new HTTPError(400, "model_id must be a positive integer");
  const deployments = (await listDeployments(modelID, false)).deployments;
  const nodes = await Promise.all(deployments.map(async (deployment) => {
    if (!deployment.active) {
      return {
        deployment_id: deployment.id,
        deployment_name: deployment.deployment_name,
        active: false,
        base_url: deployment.base_url,
        pig_base_url: deployment.base_url ? pigBaseURL(deployment.base_url) : "",
        host: hostFromEndpoint(deployment.base_url),
        pig: metricsUnavailable("Redpill listing is inactive", "disabled")
      };
    }
    const pig = deployment.base_url
      ? await fetchPigMetrics(deployment.base_url, force)
      : metricsUnavailable("deployment has no base_url");
    return {
      deployment_id: deployment.id,
      deployment_name: deployment.deployment_name,
      active: deployment.active,
      base_url: deployment.base_url,
      pig_base_url: deployment.base_url ? pigBaseURL(deployment.base_url) : "",
      host: hostFromEndpoint(deployment.base_url),
      pig
    };
  }));
  const summary = summarizePigNodes(nodes);
  return {
    model_id: modelID,
    generated_at: new Date().toISOString(),
    nodes,
    summary
  };
}

function sumNumber(list, selector) {
  return list.reduce((sum, item) => {
    const value = Number(selector(item));
    return Number.isFinite(value) ? sum + value : sum;
  }, 0);
}

function summarizePigNodes(nodes) {
  const active = nodes.filter((node) => node.active);
  const statuses = active.map((node) => node.pig?.status || "error");
  const worst = statuses.includes("red") || statuses.includes("error")
    ? "red"
    : statuses.includes("yellow") ? "yellow" : active.length > 0 ? "green" : "unknown";
  return {
    status: worst,
    total_nodes: nodes.length,
    active_nodes: active.length,
    green_nodes: active.filter((node) => node.pig?.status === "green").length,
    yellow_nodes: active.filter((node) => node.pig?.status === "yellow").length,
    red_nodes: active.filter((node) => node.pig?.status === "red").length,
    error_nodes: active.filter((node) => node.pig?.ok === false).length,
    running: sumNumber(active, (node) => node.pig?.running),
    waiting: sumNumber(active, (node) => node.pig?.waiting),
    basic_inflight: sumNumber(active, (node) => node.pig?.basic_inflight),
    premium_inflight: sumNumber(active, (node) => node.pig?.premium_inflight),
    limit: sumNumber(active, (node) => node.pig?.global_limit)
  };
}

function requirePigToken() {
  if (!pigAdminToken) throw new HTTPError(500, "PIG_ADMIN_TOKEN is not configured");
}

function normalizeTPSReference(value) {
  if (typeof value === "string" && value.trim() === "") {
    throw new HTTPError(400, "TPS reference must be an integer in [0, 1000000]");
  }
  const tpsReference = Number(value);
  if (!Number.isInteger(tpsReference) || tpsReference < 0 || tpsReference > 1000000) {
    throw new HTTPError(400, "TPS reference must be an integer in [0, 1000000]");
  }
  return tpsReference;
}

function normalizeOptionalInteger(value, label, min, max) {
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.trim() === "") {
    throw new HTTPError(400, `${label} must be an integer in [${min}, ${max}]`);
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new HTTPError(400, `${label} must be an integer in [${min}, ${max}]`);
  }
  return number;
}

function normalizePigPolicyPatch(input) {
  const payload = { ...input };
  const hasTPS = Object.hasOwn(input, "tps_reference");
  const hasWindowConcurrency = Object.hasOwn(input, "window_concurrency");
  const hasRunningLimit = Object.hasOwn(input, "running_limit");
  if (!hasTPS && !hasWindowConcurrency && !hasRunningLimit) {
    throw new HTTPError(400, "PIG policy patch must include tps_reference, window_concurrency, or running_limit");
  }
  if (hasTPS) payload.tps_reference = normalizeTPSReference(input.tps_reference);
  if (hasWindowConcurrency) {
    payload.window_concurrency = normalizeOptionalInteger(input.window_concurrency, "Window concurrency", 1, 1000000);
  }
  if (hasRunningLimit) payload.running_limit = normalizeOptionalInteger(input.running_limit, "Running limit", 0, 1000000);
  if (Object.hasOwn(input, "expected_revision")) {
    payload.expected_revision = normalizeOptionalInteger(input.expected_revision, "Expected revision", 1, 1000000000);
  }
  return payload;
}

function parsePolicyJSON(response) {
  try {
    const data = response.text ? JSON.parse(response.text) : {};
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("policy response is not a JSON object");
    }
    return data;
  } catch (err) {
    throw new HTTPError(502, `PIG policy response is not valid JSON: ${errorMessage(err)}`);
  }
}

async function pigPolicyRequest(baseURL, method, payload) {
  requirePigToken();
  const headers = {
    Authorization: `Bearer ${pigAdminToken}`,
    Accept: "application/json"
  };
  let body;
  if (payload !== undefined) {
    body = Buffer.from(JSON.stringify(payload));
    headers["Content-Type"] = "application/json";
  }
  const upstream = await fetchWithTimeout(pigBaseURL(baseURL) + pigPolicyPath, {
    method,
    headers,
    body,
    timeoutMs: pigRequestTimeoutMs
  });
  return {
    status: upstream.status,
    text: await upstream.text(),
    contentType: upstream.headers.get("content-type") || "application/json; charset=utf-8"
  };
}

async function readPigPolicyFromNode(baseURL) {
  const response = await pigPolicyRequest(baseURL, "GET");
  if (response.status < 200 || response.status >= 300) {
    throw new HTTPError(response.status, `PIG policy read failed: HTTP ${response.status} ${compactUpstreamError(response.text)}`);
  }
  const policy = parsePolicyJSON(response);
  const revision = Number(policy.revision);
  if (!Number.isFinite(revision) || revision <= 0) {
    throw new HTTPError(502, "PIG policy response has no positive numeric revision");
  }
  return policy;
}

async function patchPigPolicyDirect(baseURL, patch) {
  let latestResponse = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const policy = await readPigPolicyFromNode(baseURL);
    const revision = Number(policy.revision);
    latestResponse = await pigPolicyRequest(baseURL, "PATCH", { ...patch, expected_revision: revision });
    if (latestResponse.status !== 409) return latestResponse;
  }
  return latestResponse;
}

async function deploymentForPigPolicy(url) {
  const modelID = Number(url.searchParams.get("model_id"));
  const deploymentID = Number(url.searchParams.get("deployment_id"));
  if (!Number.isInteger(modelID) || modelID <= 0) throw new HTTPError(400, "model_id must be a positive integer");
  if (!Number.isInteger(deploymentID) || deploymentID <= 0) throw new HTTPError(400, "deployment_id must be a positive integer");
  return requireManagedDeployment(modelID, deploymentID);
}

async function proxyPigPolicy(req, res, url) {
  const deployment = await deploymentForPigPolicy(url);
  let upstream;
  if (req.method === "PATCH") {
    const input = await readJSON(req, pigPolicyBodyLimit);
    const payload = normalizePigPolicyPatch(input);
    if (Object.hasOwn(input, "expected_revision")) {
      upstream = await pigPolicyRequest(deployment.base_url, "PATCH", payload);
    } else {
      upstream = await patchPigPolicyDirect(deployment.base_url, payload);
    }
  } else {
    upstream = await pigPolicyRequest(deployment.base_url, req.method);
  }
  res.writeHead(upstream.status, {
    "Content-Type": upstream.contentType,
    "Cache-Control": "no-store"
  });
  res.end(upstream.text);
}

function parseIDFromPath(pathname, prefix, suffix = "") {
  if (!pathname.startsWith(prefix)) return null;
  if (suffix && !pathname.endsWith(suffix)) return null;
  const raw = pathname.slice(prefix.length, suffix ? -suffix.length : undefined);
  const id = Number(decodeURIComponent(raw));
  if (!Number.isInteger(id) || id <= 0) throw new HTTPError(400, "id must be a positive integer");
  return id;
}

const server = http.createServer(async (req, res) => {
  try {
    if (!requireAuth(req, res)) return;
    const url = new URL(req.url, "http://localhost");

    if (req.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/assets/"))) {
      serveStatic(req, res, url.pathname);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJSON(res, 200, {
        status: "ok",
        redpill_api_url: redpillAPIURL || null,
        redpill_api_configured: Boolean(redpillAPIURL && redpillAPIKey),
        control_cache_configured: Boolean(privateAIControlURL),
        web_cache_configured: Boolean(redpillWebURL && redpillWebRevalidateToken),
        pig_admin_configured: Boolean(pigAdminToken),
        phala_providers: phalaProviders,
        phala_host_suffixes: phalaHostSuffixes,
        model_cache_ttl_ms: modelCacheTtlMs,
        deployment_cache_ttl_ms: deploymentCacheTtlMs,
        sync_after_write_default: syncAfterWriteDefault
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/models") {
      sendJSON(res, 200, await listModels(url));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/deployments") {
      sendJSON(res, 200, await listDeployments(Number(url.searchParams.get("model_id")), boolFromSearch(url, "force", false)));
      return;
    }
    const modelDeploymentsID = parseIDFromPath(url.pathname, "/api/models/", "/deployments");
    if (req.method === "GET" && modelDeploymentsID !== null) {
      sendJSON(res, 200, await listDeployments(modelDeploymentsID, boolFromSearch(url, "force", false)));
      return;
    }
    const deploymentActiveID = parseIDFromPath(url.pathname, "/api/deployments/", "/active");
    if (req.method === "PATCH" && deploymentActiveID !== null) {
      sendJSON(res, 200, await setDeploymentActive(req, deploymentActiveID));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/deployments/active-bulk") {
      sendJSON(res, 200, await bulkSetDeploymentActive(req));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/pig/snapshot") {
      sendJSON(res, 200, await pigSnapshot(url));
      return;
    }
    if ((req.method === "GET" || req.method === "PATCH") && url.pathname === "/api/pig-policy") {
      await proxyPigPolicy(req, res, url);
      return;
    }
    sendJSON(res, 404, { error: "not found" });
  } catch (err) {
    sendError(res, err);
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`phala node admin listening on ${port}, api=${redpillAPIURL || "unconfigured"}, pig_admin=${pigAdminToken ? "configured" : "missing"}`);
});
