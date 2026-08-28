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

function json(res, value, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

function readBody(req) {
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

function makeFixtureState(pigBaseURL = "https://qwen3-8-27b.use2-19.phala.com") {
  return {
    models: [
      {
        id: 89,
        model_id: "deepseek/deepseek-v4-flash-0731",
        name: "DeepSeek: DeepSeek V4 Flash 0731",
        active: true,
        specs: { is_tee: true, context_length: 131072 }
      },
      {
        id: 101,
        model_id: "qwen/qwen3.8-27b",
        name: "Qwen: Qwen3 8-27B",
        active: true,
        specs: { is_tee: true }
      }
    ],
    deployments: {
      89: [
        {
          id: 153,
          model_id: 89,
          model_string_id: "deepseek/deepseek-v4-flash-0731",
          provider: "phala",
          provider_name: "phala",
          deployment_name: "deepseek/deepseek-v4-flash-a",
          active: true,
          config: {
            base_url: `${pigBaseURL}/v1`,
            weight: 100,
            input_cost_per_token: "0.00000001",
            output_cost_per_token: "0.00000001",
            cache_read_cost_per_token: "0",
            cache_creation_cost_per_token: "0",
            has_api_key: true
          }
        },
        {
          id: 154,
          model_id: 89,
          model_string_id: "deepseek/deepseek-v4-flash-0731",
          provider: "openrouter",
          provider_name: "openrouter",
          deployment_name: "external-openrouter",
          active: true,
          config: {
            base_url: "https://openrouter.ai/api/v1",
            weight: 10
          }
        },
        {
          id: 155,
          model_id: 89,
          model_string_id: "deepseek/deepseek-v4-flash-0731",
          provider: "phala",
          provider_name: "phala",
          deployment_name: "deepseek/deepseek-v4-flash-b",
          active: false,
          config: {
            base_url: "https://deepseek-v4-flash-b.usc2.phala.com/v1",
            weight: 100
          }
        }
      ],
      101: []
    },
    requests: []
  };
}

function redpillServer(state) {
  return http.createServer(async (req, res) => {
    state.requests.push({ method: req.method, url: req.url, key: req.headers["x-api-key"] || "" });
    assert.equal(req.headers["x-api-key"], "fixture-redpill-key");

    const deploymentsMatch = req.url.match(/^\/api\/admin\/models\/(\d+)\/deployments/);
    if (req.method === "GET" && deploymentsMatch) {
      json(res, state.deployments[Number(deploymentsMatch[1])] || []);
      return;
    }

    if (req.method === "GET" && req.url.startsWith("/api/admin/models")) {
      json(res, state.models);
      return;
    }

    const activeMatch = req.url.match(/^\/api\/admin\/deployments\/(\d+)\/active$/);
    if (req.method === "PATCH" && activeMatch) {
      const id = Number(activeMatch[1]);
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      for (const list of Object.values(state.deployments)) {
        const deployment = list.find((item) => item.id === id);
        if (deployment) {
          deployment.active = Boolean(body.active);
          json(res, deployment);
          return;
        }
      }
      json(res, { error: "not found" }, 404);
      return;
    }

    if (req.method === "GET" && req.url === "/api/admin/gateway-upstreams/preview") {
      json(res, { generated_at: "now", upstreams: [{ name: "a" }], routes: [{ id: "r" }], errors: [] });
      return;
    }

    if (req.method === "POST" && req.url === "/api/admin/gateway-upstreams/sync") {
      json(res, { upstream_count: 1, route_count: 1, config_digest: "sha256:fixture" });
      return;
    }

    json(res, { error: "not found" }, 404);
  });
}

function pigServer(state) {
  return http.createServer(async (req, res) => {
    state.requests.push({ method: req.method, url: req.url, auth: req.headers.authorization || "" });
    assert.equal(req.headers.authorization, "Bearer fixture-pig-token");
    if (req.method === "GET" && req.url === "/pig/metrics") {
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
      res.end([
        'pig_version_info{version="0.12.19"} 1',
        'pig_dynamic_state_info{state="green",source="metrics"} 1',
        "pig_dynamic_observed_running 7",
        "pig_dynamic_observed_waiting 0",
        "pig_dynamic_global_limit 32",
        "pig_tier_basic_limit 31",
        'pig_tier_inflight{tier="basic"} 6',
        'pig_tier_inflight{tier="premium"} 1',
        "pig_dynamic_observed_generation_tokens_per_second 560",
        "pig_dynamic_observed_single_user_tokens_per_second 24",
        "pig_dynamic_observed_ttft_p95_seconds 1.2",
        "pig_dynamic_observed_ttft_p99_seconds 2.3",
        "pig_dynamic_backend_count 1",
        "pig_dynamic_backend_failed 0",
        ""
      ].join("\n"));
      return;
    }
    if (req.method === "GET" && req.url === "/admin/v1/predictive-policy") {
      json(res, {
        revision: state.revision,
        source: "runtime",
        persistence: "memory",
        mutable: { tps_reference: 25, window_concurrency: 32, running_limit: 0 },
        effective: { admission_mode: "predictive", running_limit_source: "runtime" }
      });
      return;
    }
    if (req.method === "PATCH" && req.url === "/admin/v1/predictive-policy") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      assert.equal(body.expected_revision, state.revision);
      state.revision += 1;
      json(res, {
        revision: state.revision,
        source: "runtime",
        persistence: "memory",
        mutable: {
          tps_reference: body.tps_reference,
          window_concurrency: body.window_concurrency,
          running_limit: body.running_limit
        },
        effective: { admission_mode: "predictive", running_limit_source: "runtime" }
      });
      return;
    }
    json(res, { error: "not found" }, 404);
  });
}

function simplePostServer(handler) {
  return http.createServer(async (req, res) => {
    handler(req);
    json(res, req.url === "/api/revalidate" ? { revalidated: true, tags: ["models"], paths: [] } : { success: true, cleared: ["models:*"] });
  });
}

async function spawnAdmin(t, env) {
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
      REDPILL_REQUEST_TIMEOUT_MS: "1000",
      PIG_REQUEST_TIMEOUT_MS: "1000",
      ...env
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
  return { baseURL, auth };
}

test("lists models and only exposes Phala deployments for the selected model", async (t) => {
  const state = makeFixtureState();
  const redpill = redpillServer(state);
  const redpillPort = await listen(redpill);
  t.after(() => close(redpill));

  const { baseURL, auth } = await spawnAdmin(t, {
    REDPILL_API_URL: `http://127.0.0.1:${redpillPort}`,
    REDPILL_API_KEY: "fixture-redpill-key"
  });

  assert.equal((await fetch(`${baseURL}/api/health`)).status, 401);

  const allModelsResponse = await fetch(`${baseURL}/api/models`, { headers: { Authorization: auth } });
  assert.equal(allModelsResponse.status, 200);
  const allModels = await allModelsResponse.json();
  assert.deepEqual(allModels.models.map((model) => model.id), [89]);
  assert.equal(allModels.models[0].active_phala_deployment_count, 1);
  assert.equal(allModels.models[0].phala_deployment_count, 2);

  const modelsResponse = await fetch(`${baseURL}/api/models?q=deepseek`, { headers: { Authorization: auth } });
  assert.equal(modelsResponse.status, 200);
  const models = await modelsResponse.json();
  assert.equal(models.models.length, 1);
  assert.equal(models.models[0].model_id, "deepseek/deepseek-v4-flash-0731");

  const emptyModelsResponse = await fetch(`${baseURL}/api/models?q=qwen`, { headers: { Authorization: auth } });
  assert.equal(emptyModelsResponse.status, 200);
  const emptyModels = await emptyModelsResponse.json();
  assert.equal(emptyModels.models.length, 0);

  const deploymentsResponse = await fetch(`${baseURL}/api/models/89/deployments`, { headers: { Authorization: auth } });
  assert.equal(deploymentsResponse.status, 200);
  const deployments = await deploymentsResponse.json();
  assert.equal(deployments.deployments.length, 2);
  assert.equal(deployments.hidden_non_phala_count, 1);
  assert.deepEqual(deployments.deployments.map((deployment) => deployment.id), [153, 155]);
});

test("activates and deactivates only existing Phala deployments", async (t) => {
  const state = makeFixtureState();
  const redpill = redpillServer(state);
  const redpillPort = await listen(redpill);
  t.after(() => close(redpill));

  const controlSeen = [];
  const webSeen = [];
  const control = simplePostServer((req) => controlSeen.push({ url: req.url, keyHash: req.headers["x-api-key-hash"] }));
  const web = simplePostServer((req) => webSeen.push({ url: req.url, token: req.headers["x-revalidate-token"] }));
  const controlPort = await listen(control);
  const webPort = await listen(web);
  t.after(() => Promise.all([close(control), close(web)]));

  const { baseURL, auth } = await spawnAdmin(t, {
    REDPILL_API_URL: `http://127.0.0.1:${redpillPort}`,
    REDPILL_API_KEY: "fixture-redpill-key",
    PRIVATE_AI_CONTROL_URL: `http://127.0.0.1:${controlPort}`,
    REDPILL_WEB_URL: `http://127.0.0.1:${webPort}`,
    REDPILL_WEB_REVALIDATE_TOKEN: "fixture-web-token"
  });

  await fetch(`${baseURL}/api/models/89/deployments`, { headers: { Authorization: auth } });
  const response = await fetch(`${baseURL}/api/deployments/153/active`, {
    method: "PATCH",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ model_id: 89, active: false, sync_after_write: true })
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.changed, true);
  assert.equal(data.deployment.active, false);
  assert.equal(data.sync.sync.config_digest, "sha256:fixture");
  assert.equal(controlSeen.length, 1);
  assert.equal(webSeen.length, 1);

  const denied = await fetch(`${baseURL}/api/deployments/154/active`, {
    method: "PATCH",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ model_id: 89, active: false, sync_after_write: false })
  });
  assert.equal(denied.status, 403);
});

test("bulk active changes use cached deployments instead of refetching after every node", async (t) => {
  const state = makeFixtureState();
  const redpill = redpillServer(state);
  const redpillPort = await listen(redpill);
  t.after(() => close(redpill));

  const { baseURL, auth } = await spawnAdmin(t, {
    REDPILL_API_URL: `http://127.0.0.1:${redpillPort}`,
    REDPILL_API_KEY: "fixture-redpill-key"
  });

  await fetch(`${baseURL}/api/models/89/deployments`, { headers: { Authorization: auth } });
  const getDeploymentsBefore = state.requests.filter((request) => request.method === "GET" && request.url.startsWith("/api/admin/models/89/deployments")).length;
  const response = await fetch(`${baseURL}/api/deployments/active-bulk`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ model_id: 89, deployment_ids: [153, 155], active: true, sync_after_write: false })
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.results.map((item) => item.action), ["already_active", "activated"]);
  assert.equal(data.sync, null);
  const getDeploymentsAfter = state.requests.filter((request) => request.method === "GET" && request.url.startsWith("/api/admin/models/89/deployments")).length;
  assert.equal(getDeploymentsAfter, getDeploymentsBefore);
});

test("reads PIG metrics and proxies hot policy updates for a Phala deployment", async (t) => {
  const pigState = { revision: 7, requests: [] };
  const pig = pigServer(pigState);
  const pigPort = await listen(pig);
  t.after(() => close(pig));

  const state = makeFixtureState(`http://127.0.0.1:${pigPort}`);
  const redpill = redpillServer(state);
  const redpillPort = await listen(redpill);
  t.after(() => close(redpill));

  const { baseURL, auth } = await spawnAdmin(t, {
    REDPILL_API_URL: `http://127.0.0.1:${redpillPort}`,
    REDPILL_API_KEY: "fixture-redpill-key",
    PIG_ADMIN_TOKEN: "fixture-pig-token"
  });

  await fetch(`${baseURL}/api/models/89/deployments`, { headers: { Authorization: auth } });
  const snapshotResponse = await fetch(`${baseURL}/api/pig/snapshot?model_id=89&force=true`, { headers: { Authorization: auth } });
  assert.equal(snapshotResponse.status, 200);
  const snapshot = await snapshotResponse.json();
  assert.equal(snapshot.summary.running, 7);
  assert.equal(snapshot.summary.limit, 32);
  assert.equal(snapshot.nodes.find((node) => node.deployment_id === 155).pig.status, "disabled");

  const policyResponse = await fetch(`${baseURL}/api/pig-policy?model_id=89&deployment_id=153`, { headers: { Authorization: auth } });
  assert.equal(policyResponse.status, 200);
  const policy = await policyResponse.json();
  assert.equal(policy.revision, 7);

  const patchResponse = await fetch(`${baseURL}/api/pig-policy?model_id=89&deployment_id=153`, {
    method: "PATCH",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ tps_reference: 22, window_concurrency: 64, running_limit: 40 })
  });
  assert.equal(patchResponse.status, 200);
  const patched = await patchResponse.json();
  assert.equal(patched.revision, 8);
  assert.equal(patched.mutable.tps_reference, 22);
  assert.equal(pigState.requests.filter((request) => request.url === "/admin/v1/predictive-policy").length, 3);
});
