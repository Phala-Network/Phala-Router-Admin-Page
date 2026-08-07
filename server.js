"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { buildCapacityView, mergeRouterPigMetrics } = require("./capacity");

const port = Number(process.env.PORT || "8080");
const gatewayToken = process.env.GATEWAY_ADMIN_TOKEN || "";
const basicUser = process.env.BASIC_AUTH_USER || "";
const basicPasswordHash = process.env.BASIC_AUTH_PASSWORD_SHA256 || "";
const timeoutMs = Number(process.env.METRICS_TIMEOUT_MS || "2500");
const metricsStaleTtlMs = Number(process.env.METRICS_STALE_TTL_MS || "60000");
const controlStaleTtlMs = Number(process.env.CONTROL_STALE_TTL_MS || "60000");
const runtimeStaleTtlMs = Number(process.env.RUNTIME_STALE_TTL_MS || "60000");
const staticRoot = path.join(__dirname, "public");
const metricsCache = new Map();
const controlCache = new Map();
const runtimeCache = new Map();

function readRoutersConfig() {
  const file = process.env.ROUTERS_FILE || "";
  if (file) {
    try {
      return fs.readFileSync(file, "utf8");
    } catch (err) {
      console.error(`failed to read ROUTERS_FILE ${file}: ${err.message}`);
    }
  }
  return process.env.ROUTERS_JSON || "[]";
}

function parseRouters() {
  let routers = [];
  try {
    routers = JSON.parse(readRoutersConfig());
  } catch (err) {
    console.error(`failed to parse routers config: ${err.message}`);
  }
  if (!Array.isArray(routers)) routers = [];
  return routers
    .map((router, index) => ({
      id: String(router.id || router.label || `router-${index + 1}`).trim(),
      label: String(router.label || router.id || `Router ${index + 1}`).trim(),
      url: String(router.url || "").trim().replace(/\/+$/, ""),
      default_public_model: String(router.default_public_model || "model").trim(),
      default_upstream_model: String(router.default_upstream_model || router.default_public_model || "model").trim(),
      default_provider: String(router.default_provider || "phala-direct").trim(),
      default_use_shared_bearer: router.default_use_shared_bearer !== false
    }))
    .filter((router) => router.id && router.url);
}

const routers = parseRouters();

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
    "WWW-Authenticate": 'Basic realm="Phala Router Admin"',
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

function publicRouters() {
  return routers.map((router) => ({
    id: router.id,
    label: router.label,
    url: router.url,
    default_public_model: router.default_public_model,
    default_upstream_model: router.default_upstream_model,
    default_provider: router.default_provider,
    default_use_shared_bearer: router.default_use_shared_bearer
  }));
}

function cloneJSON(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function nowISO(time) {
  return new Date(time).toISOString();
}

function cacheFresh(entry, ttlMs) {
  return entry && Number.isFinite(ttlMs) && ttlMs > 0 && Date.now() - entry.at <= ttlMs;
}

function normalizedBaseURL(baseURL) {
  return String(baseURL || "").trim().replace(/\/+$/, "");
}

function sharedBearerToken() {
  if (!gatewayToken) throw new Error("gateway admin token is not configured");
  return gatewayToken;
}

function selectedRouter(url) {
  if (routers.length === 0) throw new Error("no routers configured");
  const id = url.searchParams.get("router") || routers[0].id;
  const router = routers.find((item) => item.id === id);
  if (!router) throw new Error(`unknown router: ${id}`);
  return router;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || timeoutMs);
  try {
    const requestOptions = { ...options, signal: controller.signal };
    delete requestOptions.timeoutMs;
    return await fetch(url, requestOptions);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(url, options = {}) {
  const response = await fetchWithTimeout(url, options);
  const text = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    text,
    contentType: response.headers.get("content-type") || "application/json; charset=utf-8"
  };
}

async function gatewayRequest(router, method, requestPath, body, contentType = "application/json") {
  if (!gatewayToken) throw new Error("gateway admin token is not configured");
  const headers = {
    Authorization: `Bearer ${gatewayToken}`,
    Accept: "application/json"
  };
  if (body && body.length) headers["Content-Type"] = contentType;
  const upstream = await fetchWithTimeout(router.url + requestPath, {
    method,
    headers,
    body: body && body.length ? body : undefined
  });
  const text = await upstream.text();
  return {
    status: upstream.status,
    text,
    contentType: upstream.headers.get("content-type") || "application/json; charset=utf-8"
  };
}

async function gatewayJSON(router, method, requestPath, value) {
  const body = value === undefined ? undefined : Buffer.from(JSON.stringify(value));
  const upstream = await gatewayRequest(router, method, requestPath, body);
  let data = null;
  try {
    data = upstream.text ? JSON.parse(upstream.text) : null;
  } catch {
    data = upstream.text;
  }
  if (upstream.status < 200 || upstream.status >= 300) {
    throw new Error(typeof data === "string" ? data : JSON.stringify(data));
  }
  return data;
}

async function proxyGateway(req, res, router, requestPath) {
  let body;
  if (!["GET", "HEAD"].includes(req.method)) body = await readBody(req);
  const upstream = await gatewayRequest(router, req.method, requestPath, body, req.headers["content-type"] || "application/json");
  res.writeHead(upstream.status, {
    "Content-Type": upstream.contentType,
    "Cache-Control": "no-store"
  });
  res.end(upstream.text);
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

function firstMetric(samples, name, labelKey, labelValue) {
  for (const sample of samples) {
    if (sample.name !== name) continue;
    if (labelKey && sample.labels[labelKey] !== labelValue) continue;
    return sample.value;
  }
  return null;
}

function sumMetric(samples, name) {
  let found = false;
  let total = 0;
  for (const sample of samples) {
    if (sample.name !== name) continue;
    found = true;
    total += sample.value;
  }
  return found ? total : null;
}

function maxMetric(samples, names) {
  let value = null;
  for (const sample of samples) {
    if (!names.includes(sample.name)) continue;
    if (value === null || sample.value > value) value = sample.value;
  }
  return value;
}

function parseCombinedMetrics(text) {
  const samples = parsePrometheus(text);
  const pigRawRunning = firstMetric(samples, "pig_dynamic_observed_running_raw");
  const pigRawWaiting = firstMetric(samples, "pig_dynamic_observed_waiting_raw");
  const pigRunning = firstMetric(samples, "pig_dynamic_observed_running");
  const pigWaiting = firstMetric(samples, "pig_dynamic_observed_waiting");
  const rawGlobalLimit = firstMetric(samples, "pig_dynamic_global_limit_raw");
  const globalLimit = firstMetric(samples, "pig_dynamic_global_limit");
  const predictiveAdmissionEnforce = firstMetric(samples, "pig_predictive_admission_enforce");
  const routerBackpressureActive = firstMetric(samples, "pig_dynamic_router_backpressure_active")
    ?? firstMetric(samples, "pig_predictive_router_backpressure_active");
  const routerBackpressureApplied = firstMetric(samples, "pig_dynamic_router_backpressure_applied")
    ?? firstMetric(samples, "pig_predictive_router_backpressure_applied");
  const routerInspectCapacity = firstMetric(samples, "pig_predictive_router_inspect_capacity");
  const basicLimit = firstMetric(samples, "pig_tier_basic_limit");
  const basicInflight = firstMetric(samples, "pig_tier_inflight", "tier", "basic");
  const premiumInflight = firstMetric(samples, "pig_tier_inflight", "tier", "premium");
  const backendRunning = sumMetric(samples, "vllm:num_requests_running") ?? maxMetric(samples, ["sglang:num_running_reqs"]);
  const backendWaiting = sumMetric(samples, "vllm:num_requests_waiting") ?? maxMetric(samples, ["sglang:num_queue_reqs"]);
  const kvUsage = maxMetric(samples, ["vllm:kv_cache_usage_perc", "vllm:gpu_cache_usage_perc", "sglang:token_usage"]);
  const requestAware = predictiveAdmissionEnforce !== null && predictiveAdmissionEnforce >= 0.5;
  const legacyGlobalFull = !requestAware
    && globalLimit !== null
    && pigRunning !== null
    && pigRunning >= globalLimit;
  return {
    ok: true,
    pig: {
      ok: true,
      running: pigRunning,
      waiting: pigWaiting,
      raw_running: pigRawRunning,
      raw_waiting: pigRawWaiting,
      global_limit: globalLimit,
      raw_global_limit: rawGlobalLimit,
      basic_limit: basicLimit,
      basic_inflight: basicInflight,
      premium_inflight: premiumInflight,
      predictive_admission_enforce: requestAware,
      router_backpressure_active: routerBackpressureActive === null ? null : routerBackpressureActive >= 0.5,
      router_backpressure_applied: routerBackpressureApplied === null ? null : routerBackpressureApplied >= 0.5,
      router_inspect_capacity: routerInspectCapacity,
      full_basic: pigWaiting > 0 || legacyGlobalFull || (basicLimit !== null && basicInflight !== null && basicInflight >= basicLimit),
      full_premium: pigWaiting > 0 || legacyGlobalFull
    },
    backend: {
      ok: backendRunning !== null || backendWaiting !== null || kvUsage !== null,
      running: backendRunning,
      waiting: backendWaiting,
      kv_usage: kvUsage
    }
  };
}

function cacheKey(router, name) {
  return `${router.id}:${name}`;
}

function decorateMetrics(metrics, status, sampledAt, sourceError) {
  const ageSeconds = Math.max(0, Math.round((Date.now() - sampledAt) / 1000));
  const out = {
    ...cloneJSON(metrics),
    freshness: status,
    stale: status === "stale",
    sampled_at: nowISO(sampledAt),
    age_seconds: ageSeconds
  };
  if (sourceError) out.source_error = sourceError;
  for (const section of ["pig", "backend"]) {
    out[section] = {
      ...(out[section] || {}),
      freshness: status,
      stale: status === "stale",
      sampled_at: out.sampled_at,
      age_seconds: ageSeconds
    };
    if (sourceError && status === "stale") out[section].source_error = sourceError;
  }
  return out;
}

function metricsUnavailable(message) {
  return {
    ok: false,
    freshness: "error",
    stale: false,
    pig: { ok: false, error: message },
    backend: { ok: false, error: message }
  };
}

function staleMetrics(key, message) {
  const cached = metricsCache.get(key);
  if (cacheFresh(cached, metricsStaleTtlMs)) {
    return decorateMetrics(cached.metrics, "stale", cached.at, message);
  }
  return metricsUnavailable(message);
}

async function fetchMetrics(baseURL) {
  const url = normalizedBaseURL(baseURL);
  if (!url) {
    return { ok: false, pig: { ok: false, error: "not configured" }, backend: { ok: false, error: "not configured" } };
  }
  const key = url;
  try {
    const response = await fetchText(url + "/v1/metrics", {
      headers: {
        Authorization: `Bearer ${gatewayToken}`,
        Accept: "text/plain"
      },
      timeoutMs
    });
    if (!response.ok) {
      return staleMetrics(key, `HTTP ${response.status}`);
    }
    const parsed = parseCombinedMetrics(response.text);
    const sampledAt = Date.now();
    metricsCache.set(key, { metrics: cloneJSON(parsed), at: sampledAt });
    return decorateMetrics(parsed, "fresh", sampledAt);
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    return staleMetrics(key, message);
  }
}

function numberOrZero(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function routeFor(upstream, routes) {
  const models = Object.keys(upstream.models || {});
  return routes.find((route) => route.upstream_name === upstream.name && models.includes(route.public_model))
    || routes.find((route) => route.upstream_name === upstream.name)
    || null;
}

function errorMessage(err) {
  return String(err && err.message ? err.message : err);
}

function cachedGatewaySnapshot(router, name, result, fallback) {
  const key = cacheKey(router, name);
  if (result.status === "fulfilled") {
    const value = result.value || fallback;
    controlCache.set(key, { value: cloneJSON(value), at: Date.now() });
    return { value, stale: false, warning: "", error: "" };
  }
  const message = errorMessage(result.reason);
  const cached = controlCache.get(key);
  if (cacheFresh(cached, controlStaleTtlMs)) {
    const ageSeconds = Math.max(0, Math.round((Date.now() - cached.at) / 1000));
    return {
      value: {
        ...cloneJSON(cached.value),
        stale: true,
        sampled_at: nowISO(cached.at),
        age_seconds: ageSeconds,
        source_error: message
      },
      stale: true,
      warning: `${name} stale ${ageSeconds}s: ${message}`,
      error: ""
    };
  }
  return { value: { ...fallback, error: message }, stale: false, warning: "", error: message };
}

async function buildRuntimeSnapshot(router) {
  const [upstreamsResult, routerResult, modelsResult] = await Promise.allSettled([
    gatewayJSON(router, "GET", "/v1/admin/upstreams"),
    gatewayJSON(router, "GET", "/v1/admin/router"),
    gatewayJSON(router, "GET", "/v1/models")
  ]);
  const upstreamsResolved = cachedGatewaySnapshot(router, "upstreams", upstreamsResult, { upstreams: [] });
  const routerResolved = cachedGatewaySnapshot(router, "router", routerResult, { routes: [] });
  const modelsResolved = cachedGatewaySnapshot(router, "models", modelsResult, { data: [] });
  const upstreamsSnapshot = upstreamsResolved.value;
  const routerSnapshot = routerResolved.value;
  const modelsSnapshot = modelsResolved.value;
  const upstreams = upstreamsSnapshot.upstreams || [];
  const routes = routerSnapshot.routes || [];
  const nodes = await Promise.all(upstreams.map(async (upstream) => {
    const enabled = upstream.enabled !== false;
    const route = routeFor(upstream, routes);
    const directMetrics = enabled
      ? await fetchMetrics(upstream.base_url)
      : { ok: false, pig: { ok: false }, backend: { ok: false } };
    const pig = mergeRouterPigMetrics(directMetrics.pig || {}, route || {});
    const health = enabled ? (pig.stale ? "metrics_stale" : (pig.ok ? "healthy" : "metrics_error")) : "disabled";
    const capacity = buildCapacityView({ enabled, metricsStatus: health, route: route || {}, pig });
    return {
      ...upstream,
      id: upstream.name,
      enabled,
      use_shared_bearer: upstream.bearer_token_configured !== false,
      route,
      runtime: {
        router: route || {},
        pig,
        backend: directMetrics.backend || {},
        capacity
      },
      health: {
        status: health,
        reason: !enabled
          ? ""
          : directMetrics.stale
          ? `showing ${directMetrics.age_seconds}s old metrics; ${directMetrics.source_error || "latest metrics unavailable"}`
          : (directMetrics.ok ? "" : (directMetrics.pig?.error || directMetrics.backend?.error || "metrics unavailable"))
      }
    };
  }));
  const summary = {
    nodes: nodes.length,
    enabled_nodes: nodes.filter((node) => node.enabled).length,
    selectable_nodes: nodes.filter((node) => node.runtime?.capacity?.selectable).length,
    request_aware_nodes: nodes.filter((node) => node.enabled && node.runtime?.capacity?.request_aware).length,
    protected_nodes: nodes.filter((node) => node.runtime?.capacity?.state === "protected").length,
    invalid_protocol_nodes: nodes.filter((node) => node.runtime?.capacity?.state === "protocol_invalid").length,
    routes: routes.length,
    router_running: routes.reduce((sum, route) => sum + numberOrZero(route.running), 0),
    pig_running: nodes.reduce((sum, node) => sum + numberOrZero(node.runtime?.pig?.running), 0),
    backend_running: nodes.reduce((sum, node) => sum + numberOrZero(node.runtime?.backend?.running), 0),
    waiting: nodes.reduce((sum, node) => sum + numberOrZero(node.runtime?.backend?.waiting ?? node.runtime?.pig?.waiting), 0),
    processed: routes.reduce((sum, route) => sum + numberOrZero(route.processed), 0),
    cache_selected: routes.reduce((sum, route) => sum + numberOrZero(route.selected_by_cache), 0),
    load_selected: routes.reduce((sum, route) => sum + numberOrZero(route.selected_by_load), 0),
    order_selected: routes.reduce((sum, route) => sum + numberOrZero(route.selected_by_order), 0),
    upstream_attempts: routes.reduce((sum, route) => sum + numberOrZero(route.upstream_attempts), 0),
    upstream_429: routes.reduce((sum, route) => sum + numberOrZero(route.upstream_429), 0),
    pending_reservations: routes.reduce((sum, route) => sum + numberOrZero(route.pending_reservations), 0),
    dispatch_debt: routes.reduce((sum, route) => sum + numberOrZero(route.unreconciled_dispatches), 0),
    stale_nodes: nodes.filter((node) => node.health?.status === "metrics_stale").length
  };
  const warnings = [upstreamsResolved, routerResolved, modelsResolved].map((item) => item.warning).filter(Boolean);
  const errors = [upstreamsResolved, routerResolved, modelsResolved].map((item) => item.error).filter(Boolean);
  return {
    generated_at: new Date().toISOString(),
    selected_router: publicRouters().find((item) => item.id === router.id),
    routers: publicRouters(),
    gateway: {
      url: router.url,
      config_path: upstreamsSnapshot.config_path,
      config_digest: upstreamsSnapshot.config_digest,
      router_digest: routerSnapshot.upstream_config_digest,
      stale: warnings.length > 0,
      warning: warnings.join("; ") || null,
      error: errors.join("; ") || null
    },
    router: routerSnapshot,
    models: modelsSnapshot,
    nodes,
    summary
  };
}

function markRuntimeCache(snapshot, cachedAt, refreshInFlight) {
  const out = cloneJSON(snapshot);
  const ageSeconds = Math.max(0, Math.round((Date.now() - cachedAt) / 1000));
  out.served_at = new Date().toISOString();
  out.snapshot_cache = {
    status: refreshInFlight ? "cached" : "fresh",
    age_seconds: ageSeconds,
    refresh_in_progress: Boolean(refreshInFlight),
    max_age_seconds: Math.round(runtimeStaleTtlMs / 1000)
  };
  return out;
}

function runtimeSnapshotCacheable(snapshot) {
  return !snapshot.gateway?.error || (snapshot.nodes || []).length > 0;
}

async function refreshRuntimeCache(router) {
  const key = router.id;
  const existing = runtimeCache.get(key);
  if (existing?.promise) return existing.promise;
  const promise = buildRuntimeSnapshot(router)
    .then((snapshot) => {
      if (runtimeSnapshotCacheable(snapshot)) {
        const entry = { snapshot: cloneJSON(snapshot), at: Date.now(), promise: null };
        runtimeCache.set(key, entry);
      } else if (existing?.snapshot) {
        runtimeCache.set(key, { ...existing, promise: null });
      } else {
        runtimeCache.delete(key);
      }
      return snapshot;
    })
    .catch((err) => {
      if (existing) runtimeCache.set(key, { ...existing, promise: null });
      throw err;
    });
  runtimeCache.set(key, { ...(existing || {}), promise });
  return promise;
}

async function runtimeSnapshot(router) {
  const key = router.id;
  const cached = runtimeCache.get(key);
  if (cached?.snapshot && cacheFresh(cached, runtimeStaleTtlMs)) {
    if (!cached.promise) {
      refreshRuntimeCache(router).catch((err) => {
        console.error(`runtime refresh failed for ${router.id}: ${err.message}`);
      });
    }
    return markRuntimeCache(cached.snapshot, cached.at, true);
  }
  const snapshot = await refreshRuntimeCache(router);
  const updated = runtimeCache.get(key);
  return markRuntimeCache(snapshot, updated?.at || Date.now(), false);
}

function normalizeNode(input, router) {
  const name = String(input.name || "").trim();
  if (!name) throw new Error("node name is required");
  const baseURL = String(input.base_url || "").trim().replace(/\/+$/, "");
  if (!baseURL) throw new Error("base URL is required");
  const publicModel = String(input.public_model || router.default_public_model).trim();
  const upstreamModel = String(input.upstream_model || router.default_upstream_model || publicModel).trim();
  return {
    name,
    enabled: input.enabled !== false,
    provider: String(input.provider || router.default_provider || "phala-direct").trim(),
    base_url: baseURL,
    models: { [publicModel]: upstreamModel },
    bearer_token: input.use_shared_bearer === false ? undefined : sharedBearerToken(),
    path: String(input.path || "/v1/chat/completions").trim(),
    connect_timeout_seconds: 10,
    read_timeout_seconds: 1800,
    verifier_request_timeout_seconds: 15,
    verification_refresh_seconds: 300,
    session_refresh_seconds: 300
  };
}

function copyIfPresent(input, output, key) {
  if (Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined) {
    output[key] = input[key];
  }
}

function upstreamForWrite(input) {
  const out = {};
  for (const key of [
    "name",
    "enabled",
    "provider",
    "base_url",
    "path",
    "models",
    "accepted_workload_ids",
    "accepted_image_digests",
    "accepted_dstack_kms_root_public_keys",
    "pccs_url",
    "verifier_cache_seconds",
    "connect_timeout_seconds",
    "read_timeout_seconds",
    "verifier_request_timeout_seconds",
    "verification_refresh_seconds",
    "session_refresh_seconds",
    "chutes_e2ee_api_base",
    "chutes_chute_ids",
    "chutes_e2ee_discovery_rounds",
    "chutes_e2ee_discovery_interval_seconds"
  ]) {
    copyIfPresent(input, out, key);
  }

  if (input.bearer_token === "${TOKEN}") {
    out.bearer_token = sharedBearerToken();
  } else if (typeof input.bearer_token === "string" && input.bearer_token) {
    out.bearer_token = input.bearer_token;
  } else if (input.use_shared_bearer === true || input.bearer_token_configured === true) {
    out.bearer_token = sharedBearerToken();
  }

  return out;
}

async function getUpstreams(router) {
  const snapshot = await gatewayJSON(router, "GET", "/v1/admin/upstreams");
  return snapshot.upstreams || [];
}

async function putUpstreamList(router, upstreams) {
  return gatewayJSON(router, "PUT", "/v1/admin/upstreams", upstreams.map(upstreamForWrite));
}

async function addOrUpdateNode(req, res, router) {
  const body = await readBody(req);
  const input = JSON.parse(body.toString("utf8") || "{}");
  const node = normalizeNode(input, router);
  const upstreams = await getUpstreams(router);
  const index = upstreams.findIndex((item) => item.name === node.name);
  if (index >= 0) upstreams[index] = { ...upstreams[index], ...node };
  else upstreams.push(node);
  sendJSON(res, 200, await putUpstreamList(router, upstreams));
}

async function setNodeEnabled(req, res, router, id) {
  const body = await readBody(req);
  const input = JSON.parse(body.toString("utf8") || "{}");
  const upstreams = await getUpstreams(router);
  const node = upstreams.find((item) => item.name === id);
  if (!node) throw new Error(`node not found: ${id}`);
  node.enabled = input.enabled !== false;
  sendJSON(res, 200, await putUpstreamList(router, upstreams));
}

async function removeNode(res, router, id) {
  const upstreams = await getUpstreams(router);
  const next = upstreams.filter((item) => item.name !== id);
  if (next.length === upstreams.length) throw new Error(`node not found: ${id}`);
  sendJSON(res, 200, await putUpstreamList(router, next));
}

async function putUpstreams(req, res, router) {
  const body = await readBody(req);
  const input = JSON.parse(body.toString("utf8") || "[]");
  if (!Array.isArray(input)) throw new Error("raw upstream config must be an array");
  sendJSON(res, 200, await putUpstreamList(router, input));
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
  const name = pathname === "/" ? "/index.html" : pathname;
  const resolved = path.resolve(staticRoot, "." + decodeURIComponent(name));
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

const server = http.createServer(async (req, res) => {
  try {
    if (!requireAuth(req, res)) return;
    const url = new URL(req.url, "http://localhost");

    if (req.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/assets/") || url.pathname.startsWith("/vendor/"))) {
      serveStatic(req, res, url.pathname);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/routers") {
      sendJSON(res, 200, { routers: publicRouters() });
      return;
    }

    const router = selectedRouter(url);
    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJSON(res, 200, { status: "ok", routers: routers.length, selected_router: router.id });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/runtime") {
      sendJSON(res, 200, await runtimeSnapshot(router));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/router") {
      await proxyGateway(req, res, router, "/v1/admin/router");
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/models") {
      await proxyGateway(req, res, router, "/v1/models");
      return;
    }
    if (url.pathname === "/api/upstreams") {
      if (req.method === "GET") {
        await proxyGateway(req, res, router, "/v1/admin/upstreams");
        return;
      }
      if (req.method === "PUT") {
        await putUpstreams(req, res, router);
        return;
      }
    }
    if (req.method === "POST" && url.pathname === "/api/nodes") {
      await addOrUpdateNode(req, res, router);
      return;
    }
    if (url.pathname.startsWith("/api/nodes/") && url.pathname.endsWith("/enabled")) {
      const id = decodeURIComponent(url.pathname.slice("/api/nodes/".length, -"/enabled".length));
      await setNodeEnabled(req, res, router, id);
      return;
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/api/nodes/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/nodes/".length));
      await removeNode(res, router, id);
      return;
    }
    sendJSON(res, 404, { error: "not found" });
  } catch (err) {
    sendJSON(res, 502, { error: String(err && err.message ? err.message : err) });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`router admin page listening on ${port}, routers=${routers.map((router) => router.id).join(",")}`);
});
