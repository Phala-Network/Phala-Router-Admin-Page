"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function metricsServer(metrics) {
  return http.createServer((req, res) => {
    if (req.url !== "/v1/metrics") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(metrics);
  });
}

function json(res, value) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function freePort() {
  const probe = http.createServer();
  const port = await listen(probe);
  await close(probe);
  return port;
}

async function waitForJSON(url, headers, child, output) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`admin server exited early: ${output.join("")}`);
    try {
      const response = await fetch(url, { headers });
      if (response.ok) return response.json();
    } catch {
      // The child may still be binding its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`admin server did not become ready: ${output.join("")}`);
}

test("runtime endpoint preserves legacy capacity and understands request-aware protocol states", async (t) => {
  const openMetrics = metricsServer([
    "pig_dynamic_observed_running_raw 19",
    "pig_dynamic_observed_running 19",
    "pig_dynamic_observed_waiting 0",
    "pig_dynamic_global_limit_raw 48",
    "pig_dynamic_global_limit 0",
    "pig_predictive_admission_enforce 1",
    "pig_predictive_router_backpressure_applied 0",
    "pig_predictive_router_inspect_capacity 0",
    "vllm:num_requests_running 19",
    "vllm:num_requests_waiting 0",
    "vllm:kv_cache_usage_perc 0.72"
  ].join("\n"));
  const legacyMetrics = metricsServer([
    "pig_dynamic_observed_running 24",
    "pig_dynamic_observed_waiting 0",
    "pig_dynamic_global_limit 27",
    "vllm:num_requests_running 24",
    "vllm:num_requests_waiting 0"
  ].join("\n"));
  const protectedMetrics = metricsServer([
    "pig_dynamic_observed_running 9",
    "pig_dynamic_observed_waiting 0",
    "pig_dynamic_global_limit 6",
    "pig_predictive_admission_enforce 1",
    "pig_predictive_router_backpressure_applied 1",
    "pig_predictive_router_inspect_capacity 0",
    "vllm:num_requests_running 9",
    "vllm:num_requests_waiting 0"
  ].join("\n"));
  const openPort = await listen(openMetrics);
  const legacyPort = await listen(legacyMetrics);
  const protectedPort = await listen(protectedMetrics);
  t.after(async () => Promise.all([close(openMetrics), close(legacyMetrics), close(protectedMetrics)]));

  const upstreams = [
    { name: "use1-cb", enabled: true, base_url: `http://127.0.0.1:${openPort}`, models: { model: "model" } },
    { name: "use1-4c", enabled: true, base_url: `http://127.0.0.1:${legacyPort}`, models: { model: "model" } },
    { name: "use1-protected", enabled: true, base_url: `http://127.0.0.1:${protectedPort}`, models: { model: "model" } },
    { name: "disabled", enabled: false, base_url: "http://127.0.0.1:1", models: { model: "model" } }
  ];
  const routes = [
    {
      route_id: "use1-cb:model", upstream_name: "use1-cb", public_model: "model", running: 27,
      effective_running: 27, pending_reservations: 2, unreconciled_dispatches: 1,
      selectable: true, processed: 100, upstream_attempts: 140, upstream_429: 3,
      pig_metrics: {
        ok: true, stale: false, capacity_protocol: "request_aware_open",
        raw_observed_running: 19, observed_running: 19, raw_global_limit: 48, global_limit: 0,
        predictive_admission_enforce: true, router_backpressure_applied: false,
        router_inspect_capacity: 0
      }
    },
    {
      route_id: "use1-4c:model", upstream_name: "use1-4c", public_model: "model", running: 24,
      effective_running: 24, selectable: true,
      pig_metrics: {
        ok: true, stale: false, capacity_protocol: "legacy", observed_running: 24,
        global_limit: 27, predictive_admission_enforce: false
      }
    },
    {
      route_id: "use1-protected:model", upstream_name: "use1-protected", public_model: "model", running: 9,
      effective_running: 10, selectable: false,
      pig_metrics: {
        ok: true, stale: false, capacity_protocol: "request_aware_protected", observed_running: 9,
        global_limit: 6, predictive_admission_enforce: true, router_backpressure_applied: true,
        router_inspect_capacity: 0
      }
    },
    {
      route_id: "disabled:model", upstream_name: "disabled", public_model: "model", running: 99,
      effective_running: 99, selectable: true,
      pig_metrics: { ok: true, stale: false, capacity_protocol: "request_aware_open" }
    }
  ];
  const gateway = http.createServer((req, res) => {
    if (req.url === "/v1/admin/upstreams") return json(res, { upstreams });
    if (req.url === "/v1/admin/router") return json(res, { routes });
    if (req.url === "/v1/models") return json(res, { data: [{ id: "model" }] });
    res.writeHead(404).end();
  });
  const gatewayPort = await listen(gateway);
  t.after(() => close(gateway));

  const adminPort = await freePort();
  const username = "tester";
  const password = "integration-secret";
  const auth = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const output = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(adminPort),
      BASIC_AUTH_USER: username,
      BASIC_AUTH_PASSWORD_SHA256: crypto.createHash("sha256").update(password).digest("hex"),
      GATEWAY_ADMIN_TOKEN: "fixture-token",
      METRICS_TIMEOUT_MS: "1000",
      ROUTERS_JSON: JSON.stringify([{ id: "fixture", label: "Fixture", url: `http://127.0.0.1:${gatewayPort}` }])
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGTERM");
  });

  const baseURL = `http://127.0.0.1:${adminPort}`;
  const health = await waitForJSON(`${baseURL}/api/health`, { Authorization: auth }, child, output);
  assert.equal(health.status, "ok");
  assert.equal((await fetch(`${baseURL}/api/health`)).status, 401);

  const response = await fetch(`${baseURL}/api/runtime`, { headers: { Authorization: auth } });
  assert.equal(response.status, 200);
  const runtime = await response.json();
  const byName = Object.fromEntries(runtime.nodes.map((node) => [node.name, node]));

  assert.equal(byName["use1-cb"].runtime.capacity.state, "open");
  assert.equal(byName["use1-cb"].runtime.capacity.display_limit, null);
  assert.equal(byName["use1-cb"].runtime.capacity.effective_running, 27);
  assert.equal(byName["use1-cb"].runtime.capacity.dispatch_debt, 1);
  assert.equal(byName["use1-4c"].runtime.capacity.state, "legacy");
  assert.equal(byName["use1-4c"].runtime.capacity.display_limit, 27);
  assert.equal(byName["use1-protected"].runtime.capacity.state, "protected");
  assert.equal(byName["use1-protected"].runtime.capacity.selectable, false);
  assert.equal(byName.disabled.runtime.capacity.state, "disabled");
  assert.equal(byName.disabled.health.reason, "");
  assert.equal(runtime.summary.request_aware_nodes, 2);
  assert.equal(runtime.summary.protected_nodes, 1);
  assert.equal(runtime.summary.selectable_nodes, 2);
  assert.equal(runtime.summary.upstream_429, 3);

  const page = await fetch(baseURL, { headers: { Authorization: auth } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /PIG capacity/);
});

test("PIG TPS policy can be adjusted directly with server-side revision handling", async (t) => {
  let currentRevision = 7;
  let patchAttempts = 0;
  const receivedPatches = [];
  const pig = http.createServer(async (req, res) => {
    if (req.url !== "/admin/v1/predictive-policy") {
      res.writeHead(404).end();
      return;
    }
    assert.equal(req.headers.authorization, "Bearer fixture-token");
    if (req.method === "GET") {
      json(res, {
        schema_version: "pig.predictive-policy.v1",
        revision: currentRevision,
        source: "runtime",
        persistence: "restart_restores_startup",
        mutable: { tps_reference: 25 },
        effective: { admission_mode: "enforce" }
      });
      return;
    }
    if (req.method === "PATCH") {
      patchAttempts += 1;
      const payload = JSON.parse((await readRequestBody(req)).toString("utf8") || "{}");
      receivedPatches.push(payload);
      if (patchAttempts === 1) {
        currentRevision = 8;
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "revision changed" }));
        return;
      }
      assert.deepEqual(payload, { expected_revision: 8, tps_reference: 45.5 });
      currentRevision = 9;
      json(res, {
        schema_version: "pig.predictive-policy.v1",
        revision: currentRevision,
        source: "runtime",
        mutable: { tps_reference: payload.tps_reference },
        effective: { admission_mode: "enforce" }
      });
      return;
    }
    res.writeHead(405).end();
  });
  const pigPort = await listen(pig);
  t.after(() => close(pig));

  const upstreams = [
    { name: "use1-4c", enabled: true, base_url: `http://127.0.0.1:${pigPort}`, models: { model: "model" } }
  ];
  const gateway = http.createServer((req, res) => {
    if (req.url === "/v1/admin/upstreams") return json(res, { upstreams });
    res.writeHead(404).end();
  });
  const gatewayPort = await listen(gateway);
  t.after(() => close(gateway));

  const adminPort = await freePort();
  const username = "tester";
  const password = "integration-secret";
  const auth = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const output = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(adminPort),
      BASIC_AUTH_USER: username,
      BASIC_AUTH_PASSWORD_SHA256: crypto.createHash("sha256").update(password).digest("hex"),
      GATEWAY_ADMIN_TOKEN: "fixture-token",
      METRICS_TIMEOUT_MS: "1000",
      ROUTERS_JSON: JSON.stringify([{ id: "fixture", label: "Fixture", url: `http://127.0.0.1:${gatewayPort}` }])
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGTERM");
  });

  const baseURL = `http://127.0.0.1:${adminPort}`;
  await waitForJSON(`${baseURL}/api/health`, { Authorization: auth }, child, output);

  const response = await fetch(`${baseURL}/api/pig-policy?router=fixture&node=use1-4c`, {
    method: "PATCH",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ tps_reference: 45.5 })
  });
  assert.equal(response.status, 200);
  const policy = await response.json();
  assert.equal(policy.revision, 9);
  assert.equal(policy.mutable.tps_reference, 45.5);
  assert.deepEqual(receivedPatches, [
    { expected_revision: 7, tps_reference: 45.5 },
    { expected_revision: 8, tps_reference: 45.5 }
  ]);
});
