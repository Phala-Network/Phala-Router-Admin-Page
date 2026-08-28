"use strict";

const $ = (id) => document.getElementById(id);

let models = [];
let deployments = [];
let pigNodes = [];
let selectedModel = null;
let selectedDeployment = null;
let selectedIDs = new Set();
let latestPolicy = null;
let pigTimer = 0;
let redpillTimer = 0;
let pigRefreshInFlight = false;
let redpillRefreshInFlight = false;
let runningHistory = [];

const PIG_REFRESH_MS = 2000;
const REDPILL_REFRESH_MS = 300000;
const MAX_HISTORY_POINTS = 180;

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[ch]));
}

function escapeAttr(value) {
  return escapeHTML(value).replace(/`/g, "&#096;");
}

function fmt(value, digits = 2) {
  if (value === null || value === undefined || value === "") return "-";
  const number = Number(value);
  if (Number.isFinite(number)) {
    if (Number.isInteger(number)) return String(number);
    return number.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
  }
  return String(value);
}

function shortHost(value) {
  try {
    const url = new URL(value);
    return url.host + url.pathname.replace(/\/$/, "");
  } catch {
    return value || "";
  }
}

function setStatus(text, tone) {
  const el = $("status-line");
  el.textContent = text || "";
  el.className = `status-line ${tone || ""}`.trim();
}

function log(value, tone) {
  const stamp = new Date().toLocaleTimeString();
  const line = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const el = $("log");
  el.textContent = `[${stamp}] ${line}\n\n${el.textContent || ""}`;
  el.className = tone || "";
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) throw new Error(typeof data === "string" ? data : JSON.stringify(data));
  return data;
}

function pigForDeployment(id) {
  return pigNodes.find((node) => String(node.deployment_id) === String(id))?.pig || null;
}

function selectedPigNode() {
  if (!selectedDeployment) return null;
  return pigNodes.find((node) => String(node.deployment_id) === String(selectedDeployment.id)) || null;
}

function pct(value, limit) {
  const v = Number(value);
  const l = Number(limit);
  if (!Number.isFinite(v) || !Number.isFinite(l) || l <= 0) return 0;
  return Math.max(0, Math.min(100, (v / l) * 100));
}

function bar(value, limit, tone) {
  const p = pct(value, limit);
  return `<div class="bar ${escapeAttr(tone || "neutral")}" style="--w:${p}%"><span></span></div>`;
}

function modelTone(model) {
  return model.active ? "green" : "disabled";
}

function deploymentTone(deployment) {
  if (!deployment.active) return "disabled";
  const pig = pigForDeployment(deployment.id);
  return pig?.status || "neutral";
}

function activeDeployments() {
  return deployments.filter((deployment) => deployment.active);
}

function pigSummary() {
  const activeNodes = pigNodes.filter((node) => node.active);
  const status = activeNodes.some((node) => node.pig?.status === "red" || node.pig?.status === "error")
    ? "red"
    : activeNodes.some((node) => node.pig?.status === "yellow")
      ? "yellow"
      : activeNodes.length > 0 ? "green" : "unknown";
  const sum = (key) => activeNodes.reduce((total, node) => {
    const value = Number(node.pig?.[key]);
    return Number.isFinite(value) ? total + value : total;
  }, 0);
  return {
    status,
    running: sum("running"),
    waiting: sum("waiting"),
    limit: sum("global_limit"),
    green_nodes: activeNodes.filter((node) => node.pig?.status === "green").length,
    yellow_nodes: activeNodes.filter((node) => node.pig?.status === "yellow").length,
    red_nodes: activeNodes.filter((node) => node.pig?.status === "red").length,
    error_nodes: activeNodes.filter((node) => node.pig?.ok === false).length
  };
}

function setDeployments(next) {
  deployments = (next || []).slice().sort((a, b) => Number(a.id) - Number(b.id));
  selectedIDs = new Set([...selectedIDs].filter((id) => deployments.some((deployment) => String(deployment.id) === String(id))));
  if (selectedDeployment) {
    selectedDeployment = deployments.find((deployment) => String(deployment.id) === String(selectedDeployment.id)) || null;
  }
  render();
}

function renderSummary() {
  const active = activeDeployments();
  const summary = pigSummary();
  const cards = [
    {
      label: "Models",
      value: models.length,
      hint: `${models.filter((model) => model.active).length} active in Redpill`,
      tone: "green"
    },
    {
      label: "Selected",
      value: selectedModel ? selectedModel.id : "-",
      hint: selectedModel?.model_id || "none",
      tone: selectedModel?.active ? "green" : "disabled"
    },
    {
      label: "Phala listings",
      value: `${active.length} / ${deployments.length}`,
      hint: "active / known for this model",
      tone: active.length > 0 ? "green" : "yellow"
    },
    {
      label: "PIG running",
      value: fmt(summary.running),
      hint: `limit ${fmt(summary.limit)} waiting ${fmt(summary.waiting)}`,
      tone: summary.status
    },
    {
      label: "PIG status",
      value: summary.status.toUpperCase(),
      hint: `${summary.green_nodes} green, ${summary.yellow_nodes} yellow, ${summary.red_nodes + summary.error_nodes} red/error`,
      tone: summary.status
    }
  ];
  $("summary").innerHTML = cards.map((card) => `
    <article class="stat ${escapeAttr(card.tone)}">
      <div class="stat-label">${escapeHTML(card.label)}</div>
      <div class="stat-value">${escapeHTML(fmt(card.value))}</div>
      <div class="stat-hint">${escapeHTML(card.hint)}</div>
    </article>
  `).join("");
}

function renderModels() {
  $("model-count").textContent = `${models.length} loaded`;
  if (models.length === 0) {
    $("model-list").innerHTML = `<div class="empty">No models loaded</div>`;
    return;
  }
  $("model-list").innerHTML = models.map((model) => {
    const selected = selectedModel && String(selectedModel.id) === String(model.id);
    return `
      <button class="model-row ${selected ? "selected" : ""}" data-model-id="${escapeAttr(model.id)}" type="button">
        <span class="model-main">
          <strong>${escapeHTML(model.model_id)}</strong>
          <span>${escapeHTML(model.name || "")}</span>
        </span>
        <span class="pill ${escapeAttr(modelTone(model))}">${model.active ? "active" : "inactive"}</span>
      </button>
    `;
  }).join("");
}

function renderDeployments() {
  $("deployments-title").textContent = selectedModel ? selectedModel.model_id : "Phala deployments";
  $("deployments-subtitle").textContent = selectedModel ? `${deployments.length} Phala listings, ${selectedIDs.size} selected` : "select a model";
  if (!selectedModel) {
    $("deployments-body").innerHTML = `<tr><td colspan="9" class="empty">Select a model on the left</td></tr>`;
    return;
  }
  if (deployments.length === 0) {
    $("deployments-body").innerHTML = `<tr><td colspan="9" class="empty">No Phala deployments for this model</td></tr>`;
    return;
  }
  $("deployments-body").innerHTML = deployments.map((deployment) => {
    const selected = selectedDeployment && String(selectedDeployment.id) === String(deployment.id);
    const checked = selectedIDs.has(String(deployment.id));
    const pig = pigForDeployment(deployment.id);
    const tone = deploymentTone(deployment);
    const running = pig?.running;
    const limit = pig?.global_limit;
    const waiting = pig?.waiting;
    return `
      <tr class="${selected ? "selected" : ""}" data-deployment-id="${escapeAttr(deployment.id)}">
        <td><input class="row-check" type="checkbox" data-action="select" ${checked ? "checked" : ""} aria-label="select deployment ${escapeAttr(deployment.id)}"></td>
        <td><span class="pill ${escapeAttr(deployment.active ? "green" : "disabled")}">${deployment.active ? "active" : "inactive"}</span></td>
        <td>
          <div class="node-title">#${escapeHTML(deployment.id)} ${escapeHTML(deployment.deployment_name || "")}</div>
          <div class="subline mono">${escapeHTML(deployment.model_string_id || "")}</div>
        </td>
        <td>
          <div class="mono">${escapeHTML(shortHost(deployment.base_url))}</div>
          <div class="subline">${escapeHTML(deployment.base_url || "")}</div>
        </td>
        <td>
          <div class="metric-head"><span class="mono">${escapeHTML(fmt(running))} / ${escapeHTML(fmt(limit))}</span><span class="pill ${escapeAttr(tone)}">${escapeHTML(pig?.status || "not loaded")}</span></div>
          ${bar(running, limit, tone)}
          <div class="subline mono">waiting ${escapeHTML(fmt(waiting))} basic ${escapeHTML(fmt(pig?.basic_inflight))} premium ${escapeHTML(fmt(pig?.premium_inflight))}</div>
        </td>
        <td>
          <div class="mono">tps ${escapeHTML(fmt(pig?.user_tps))} gen ${escapeHTML(fmt(pig?.generation_tps))}</div>
          <div class="subline mono">ttft p95 ${escapeHTML(fmt(pig?.ttft_p95_seconds))}s p99 ${escapeHTML(fmt(pig?.ttft_p99_seconds))}s</div>
        </td>
        <td><span class="mono">${escapeHTML(fmt(deployment.weight))}</span></td>
        <td><span class="mono compact">${escapeHTML(deployment.updated_at || "-")}</span></td>
        <td>
          <div class="row-actions">
            <button data-action="pig" type="button">PIG</button>
            <button data-action="toggle" class="${deployment.active ? "danger" : "primary"}" type="button">
              ${deployment.active ? "Down" : "Up"}
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join("");
}

function drawChart() {
  const canvas = $("running-chart");
  const ctx = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(320, Math.floor(rect.width));
  const height = Math.max(160, Math.floor(rect.height));
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr;
    canvas.height = height * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "rgba(12, 18, 16, 0.8)";
  ctx.fillRect(0, 0, width, height);

  const padding = { left: 42, right: 14, top: 18, bottom: 26 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;
  ctx.strokeStyle = "rgba(146, 170, 161, 0.22)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = padding.top + (plotH * i / 4);
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
  }

  const maxValue = Math.max(1, ...runningHistory.map((point) => Math.max(point.running, point.limit || 0, point.waiting || 0)));
  drawSeries(ctx, width, height, padding, maxValue, "limit", "rgba(145, 170, 161, 0.75)");
  drawSeries(ctx, width, height, padding, maxValue, "running", "#00d18f");
  drawSeries(ctx, width, height, padding, maxValue, "waiting", "#ff5263");

  ctx.fillStyle = "rgba(238, 248, 244, 0.8)";
  ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.fillText(`max ${fmt(maxValue)}`, 8, padding.top + 4);
  ctx.fillText("running", padding.left, height - 8);
  ctx.fillStyle = "#91aaa1";
  ctx.fillText("limit", padding.left + 72, height - 8);
  ctx.fillStyle = "#ff5263";
  ctx.fillText("waiting", padding.left + 126, height - 8);
}

function drawSeries(ctx, width, height, padding, maxValue, key, color) {
  const points = runningHistory;
  if (points.length < 2) return;
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;
  ctx.strokeStyle = color;
  ctx.lineWidth = key === "running" ? 2 : 1.5;
  ctx.beginPath();
  points.forEach((point, index) => {
    const x = padding.left + (plotW * index / Math.max(1, points.length - 1));
    const y = padding.top + plotH - (plotH * Number(point[key] || 0) / maxValue);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function renderPigPanel() {
  const summary = pigSummary();
  $("pig-panel-title").textContent = selectedModel ? `PIG: ${selectedModel.model_id}` : "PIG runtime";
  $("pig-panel-subtitle").textContent = `${summary.status} | running ${fmt(summary.running)} / ${fmt(summary.limit)} | waiting ${fmt(summary.waiting)}`;
  drawChart();

  const node = selectedPigNode();
  $("pig-policy-target").textContent = selectedDeployment ? shortHost(selectedDeployment.base_url) : "select a Phala node";
  $("pig-policy-refresh-btn").disabled = !selectedDeployment;
  $("pig-policy-save-btn").disabled = !selectedDeployment;
  if (!selectedDeployment) return;
  if (!latestPolicy || String(latestPolicy.deployment_id) !== String(selectedDeployment.id)) {
    $("pig-tps-reference").value = "";
    $("pig-window-concurrency").value = "";
    $("pig-running-limit").value = "";
    $("pig-policy-revision").textContent = "-";
    $("pig-policy-source").textContent = "-";
    $("pig-policy-mode").textContent = "-";
  }
  if (node?.pig?.ok === false && (!latestPolicy || String(latestPolicy.deployment_id) !== String(selectedDeployment.id))) {
    $("pig-policy-message").textContent = node.pig.error || "PIG metrics unavailable";
    $("pig-policy-message").className = "subline mono err";
  }
}

function render() {
  renderSummary();
  renderModels();
  renderDeployments();
  renderPigPanel();
}

async function loadModels(force = false) {
  const q = encodeURIComponent($("model-search").value.trim());
  const active = encodeURIComponent($("model-active-filter").value);
  const data = await api(`/api/models?q=${q}&active=${active}${force ? "&force=true" : ""}`);
  models = data.models || [];
  if (selectedModel && !models.find((model) => String(model.id) === String(selectedModel.id))) {
    selectedModel = null;
    selectedDeployment = null;
    deployments = [];
    pigNodes = [];
    runningHistory = [];
    selectedIDs.clear();
  }
  if (!selectedModel && models.length > 0) selectedModel = models.find((model) => model.active) || models[0];
  renderModels();
  await loadDeployments(force);
}

async function loadDeployments(force = false) {
  if (!selectedModel) {
    deployments = [];
    pigNodes = [];
    selectedIDs.clear();
    render();
    return;
  }
  const data = await api(`/api/models/${encodeURIComponent(selectedModel.id)}/deployments${force ? "?force=true" : ""}`);
  deployments = data.deployments || [];
  selectedIDs = new Set([...selectedIDs].filter((id) => deployments.some((deployment) => String(deployment.id) === String(id))));
  if (selectedDeployment) {
    selectedDeployment = deployments.find((deployment) => String(deployment.id) === String(selectedDeployment.id)) || null;
  }
  render();
  await refreshPig();
}

async function refreshRedpill(force = false) {
  if (redpillRefreshInFlight) return;
  window.clearTimeout(redpillTimer);
  redpillRefreshInFlight = true;
  try {
    setStatus(force ? "refreshing Redpill from origin..." : "refreshing Redpill...");
    await loadModels(force);
    setStatus(`Redpill loaded at ${new Date().toLocaleTimeString()}`, "ok");
  } catch (err) {
    setStatus("Redpill refresh failed", "err");
    log(err.message, "err");
  } finally {
    redpillRefreshInFlight = false;
    redpillTimer = window.setTimeout(() => refreshRedpill(false), REDPILL_REFRESH_MS);
  }
}

async function refreshPig(force = false) {
  if (!selectedModel || pigRefreshInFlight) return;
  window.clearTimeout(pigTimer);
  pigRefreshInFlight = true;
  try {
    const data = await api(`/api/pig/snapshot?model_id=${encodeURIComponent(selectedModel.id)}${force ? "&force=true" : ""}`);
    pigNodes = data.nodes || [];
    const summary = data.summary || pigSummary();
    runningHistory.push({
      at: Date.now(),
      running: Number(summary.running || 0),
      waiting: Number(summary.waiting || 0),
      limit: Number(summary.limit || 0)
    });
    if (runningHistory.length > MAX_HISTORY_POINTS) runningHistory = runningHistory.slice(-MAX_HISTORY_POINTS);
    render();
  } catch (err) {
    log(`PIG refresh failed: ${err.message}`, "err");
  } finally {
    pigRefreshInFlight = false;
    pigTimer = window.setTimeout(() => refreshPig(false), PIG_REFRESH_MS);
  }
}

function selectModel(id) {
  selectedModel = models.find((model) => String(model.id) === String(id)) || null;
  selectedDeployment = null;
  latestPolicy = null;
  pigNodes = [];
  runningHistory = [];
  selectedIDs.clear();
  renderModels();
  loadDeployments(false).catch((err) => log(err.message, "err"));
}

function confirmWrite(message, payload) {
  const details = payload ? `\n\n${JSON.stringify(payload, null, 2)}` : "";
  return window.confirm(`${message}${details}`);
}

async function setDeploymentActive(deployment, active) {
  const verb = active ? "Activate" : "Deactivate";
  const payload = {
    model_id: selectedModel?.id,
    active,
    sync_after_write: true
  };
  if (!confirmWrite(`${verb} Phala deployment #${deployment.id}?`, {
    model: selectedModel?.model_id,
    deployment_id: deployment.id,
    base_url: deployment.base_url,
    active
  })) return;
  const data = await api(`/api/deployments/${encodeURIComponent(deployment.id)}/active`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
  log({ changed: data.changed, deployment: data.deployment, sync: data.sync }, "ok");
  if (data.deployments) setDeployments(data.deployments);
  await refreshPig(true);
}

async function bulkSetActive(active) {
  if (!selectedModel) throw new Error("select a model first");
  const ids = [...selectedIDs].map(Number);
  if (ids.length === 0) throw new Error("select at least one deployment");
  const payload = {
    model_id: selectedModel.id,
    deployment_ids: ids,
    active,
    sync_after_write: true
  };
  if (!confirmWrite(`${active ? "Activate" : "Deactivate"} ${ids.length} selected Phala deployments?`, payload)) return;
  const data = await api("/api/deployments/active-bulk", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  log(data, "ok");
  if (data.deployments) setDeployments(data.deployments);
  await refreshPig(true);
}

function parsePolicyInteger(value, label, min, max) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error(`${label} must be an integer in [${min}, ${max}]`);
  const number = Number(raw);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${label} must be an integer in [${min}, ${max}]`);
  }
  return number;
}

function loadPolicyIntoForm(policy) {
  latestPolicy = { ...policy, deployment_id: selectedDeployment.id };
  const mutable = policy.mutable || {};
  const effective = policy.effective || {};
  $("pig-tps-reference").value = mutable.tps_reference ?? "";
  $("pig-window-concurrency").value = mutable.window_concurrency ?? "";
  $("pig-running-limit").value = mutable.running_limit ?? "";
  $("pig-policy-revision").textContent = fmt(policy.revision);
  $("pig-policy-source").textContent = policy.source || "-";
  $("pig-policy-mode").textContent = effective.admission_mode || "-";
  $("pig-policy-message").textContent = `loaded revision ${fmt(policy.revision)}; ${policy.persistence || "runtime"}`;
  $("pig-policy-message").className = "subline mono ok";
}

async function readPigPolicy() {
  if (!selectedModel || !selectedDeployment) throw new Error("select a Phala deployment first");
  $("pig-policy-message").textContent = "reading policy...";
  $("pig-policy-message").className = "subline mono";
  const policy = await api(`/api/pig-policy?model_id=${encodeURIComponent(selectedModel.id)}&deployment_id=${encodeURIComponent(selectedDeployment.id)}`);
  loadPolicyIntoForm(policy);
  renderPigPanel();
  return policy;
}

async function savePigPolicy() {
  if (!selectedModel || !selectedDeployment) throw new Error("select a Phala deployment first");
  const payload = {
    tps_reference: parsePolicyInteger($("pig-tps-reference").value, "TPS reference", 0, 1000000),
    window_concurrency: parsePolicyInteger($("pig-window-concurrency").value, "Window concurrency", 1, 1000000),
    running_limit: parsePolicyInteger($("pig-running-limit").value, "Running limit", 0, 1000000)
  };
  const revision = Number(latestPolicy?.revision);
  if (Number.isFinite(revision) && revision > 0) payload.expected_revision = revision;
  if (!confirmWrite(`Save PIG hot policy for #${selectedDeployment.id}?`, payload)) return;
  $("pig-policy-message").textContent = "saving policy...";
  $("pig-policy-message").className = "subline mono";
  const policy = await api(`/api/pig-policy?model_id=${encodeURIComponent(selectedModel.id)}&deployment_id=${encodeURIComponent(selectedDeployment.id)}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
  loadPolicyIntoForm(policy);
  log(`PIG policy saved for ${shortHost(selectedDeployment.base_url)} revision ${fmt(policy.revision)}`, "ok");
  await refreshPig(true);
}

function selectDeployment(deployment) {
  selectedDeployment = deployment;
  latestPolicy = null;
  $("pig-policy-message").textContent = "policy not loaded";
  $("pig-policy-message").className = "subline mono";
  render();
}

function toggleSelection(id, checked) {
  if (checked) selectedIDs.add(String(id));
  else selectedIDs.delete(String(id));
  renderDeployments();
}

function selectBy(predicate) {
  selectedIDs = new Set(deployments.filter(predicate).map((deployment) => String(deployment.id)));
  renderDeployments();
}

$("model-search").addEventListener("input", () => {
  window.clearTimeout(redpillTimer);
  redpillTimer = window.setTimeout(() => refreshRedpill(false), 250);
});
$("model-active-filter").addEventListener("change", () => refreshRedpill(false));
$("refresh-btn").addEventListener("click", () => refreshRedpill(true));
$("pig-refresh-btn").addEventListener("click", () => refreshPig(true));
$("select-active-btn").addEventListener("click", () => selectBy((deployment) => deployment.active));
$("select-inactive-btn").addEventListener("click", () => selectBy((deployment) => !deployment.active));
$("clear-selection-btn").addEventListener("click", () => selectBy(() => false));
$("bulk-up-btn").addEventListener("click", () => bulkSetActive(true).catch((err) => log(err.message, "err")));
$("bulk-down-btn").addEventListener("click", () => bulkSetActive(false).catch((err) => log(err.message, "err")));
$("clear-log-btn").addEventListener("click", () => {
  $("log").textContent = "";
});
$("pig-policy-refresh-btn").addEventListener("click", () => readPigPolicy().catch((err) => log(err.message, "err")));
$("pig-policy-save-btn").addEventListener("click", () => savePigPolicy().catch((err) => log(err.message, "err")));

$("model-list").addEventListener("click", (event) => {
  const row = event.target.closest("[data-model-id]");
  if (!row) return;
  selectModel(row.dataset.modelId);
});

$("deployments-body").addEventListener("change", (event) => {
  const checkbox = event.target.closest('input[data-action="select"]');
  const row = event.target.closest("[data-deployment-id]");
  if (!checkbox || !row) return;
  toggleSelection(row.dataset.deploymentId, checkbox.checked);
});

$("deployments-body").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  const row = event.target.closest("[data-deployment-id]");
  if (!button || !row) return;
  const deployment = deployments.find((item) => String(item.id) === String(row.dataset.deploymentId));
  if (!deployment) return;
  if (button.dataset.action === "pig") {
    selectDeployment(deployment);
    readPigPolicy().catch((err) => log(err.message, "err"));
    return;
  }
  if (button.dataset.action === "toggle") {
    setDeploymentActive(deployment, !deployment.active).catch((err) => log(err.message, "err"));
  }
});

window.addEventListener("resize", drawChart);

refreshRedpill(true);
pigTimer = window.setTimeout(() => refreshPig(false), PIG_REFRESH_MS);
