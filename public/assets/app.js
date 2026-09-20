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
let chartHover = null;
let logExpanded = false;
let logEntryCount = 0;
let lastLogLine = "";
let lastLogTone = "";

const PIG_REFRESH_MS = 2000;
const REDPILL_REFRESH_MS = 300000;
const CHART_WINDOW_MS = 5 * 60 * 1000;
const MAX_HISTORY_POINTS = Math.ceil(CHART_WINDOW_MS / PIG_REFRESH_MS);
const STACK_COLORS = [
  "#00d18f",
  "#5bb8ff",
  "#ffbd4a",
  "#b37cff",
  "#ff7aa8",
  "#45e0d0",
  "#a5e85f",
  "#ff8f4a",
  "#8ea0ff",
  "#f0dc5c"
];

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

function nodeLabel(value) {
  const host = shortHost(value).split("/")[0];
  const parts = host.split(".");
  if (parts.length >= 3 && parts.at(-2) === "phala" && parts.at(-1) === "com") {
    return parts.at(-3);
  }
  return host || "-";
}

function deploymentBaseURL(deployment) {
  return deployment?.base_url || deployment?.config?.base_url || "";
}

function setStatus(text, tone) {
  const el = $("status-line");
  el.textContent = text || "";
  el.className = `status-line ${tone || ""}`.trim();
}

function updateLogPanel() {
  const panel = $("log-panel");
  const button = $("log-toggle-btn");
  const arrow = $("log-toggle-arrow");
  const summary = $("log-toggle-summary");
  if (!panel || !button || !arrow || !summary) return;
  panel.classList.toggle("collapsed", !logExpanded);
  panel.setAttribute("aria-expanded", String(logExpanded));
  button.setAttribute("aria-expanded", String(logExpanded));
  arrow.textContent = logExpanded ? ">" : "<";
  summary.textContent = logEntryCount > 0 ? `${logEntryCount} entries | ${lastLogLine}` : "no entries";
  button.title = summary.textContent;
  summary.className = `log-toggle-summary ${lastLogTone || ""}`.trim();
}

function log(value, tone) {
  const stamp = new Date().toLocaleTimeString();
  const line = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const el = $("log");
  el.textContent = `[${stamp}] ${line}\n\n${el.textContent || ""}`;
  el.className = tone || "";
  logEntryCount += 1;
  lastLogLine = line.replace(/\s+/g, " ").slice(0, 120);
  lastLogTone = tone || "";
  updateLogPanel();
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

function pigLimit(pig) {
  const candidates = [
    pig?.effective_limit,
    pig?.global_limit,
    pig?.admission_limit,
    pig?.hard_global_limit,
    pig?.basic_limit,
    pig?.capacity_limit,
    pig?.capacity_safe_limit,
    pig?.capacity_target_limit,
    pig?.capacity_learned_limit
  ];
  for (const value of candidates) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
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
  const count = Number(model.active_phala_deployment_count);
  if (Number.isFinite(count) && count > 0) return "green";
  return model.active ? "yellow" : "disabled";
}

function deploymentTone(deployment) {
  if (!deployment.active) return "disabled";
  const pig = pigForDeployment(deployment.id);
  return pig?.status || "neutral";
}

function activeDeployments() {
  return deployments.filter((deployment) => deployment.active);
}

function sortedDeployments(next) {
  return (next || []).slice().sort((a, b) => {
    if (Boolean(a.active) !== Boolean(b.active)) return a.active ? -1 : 1;
    const byNode = nodeLabel(deploymentBaseURL(a)).localeCompare(nodeLabel(deploymentBaseURL(b)), undefined, { numeric: true, sensitivity: "base" });
    if (byNode !== 0) return byNode;
    return Number(a.id) - Number(b.id);
  });
}

function pigSummary() {
  const activeNodes = pigNodes.filter((node) => node.active);
  const status = activeNodes.some((node) => node.pig?.status === "red" || node.pig?.status === "error")
    ? "red"
    : activeNodes.some((node) => node.pig?.status === "yellow")
      ? "yellow"
      : activeNodes.some((node) => node.pig?.status === "unknown") ? "unknown" : activeNodes.length > 0 ? "green" : "unknown";
  const sum = (key) => activeNodes.reduce((total, node) => {
    const value = Number(node.pig?.[key]);
    return Number.isFinite(value) ? total + value : total;
  }, 0);
  const knownLimits = activeNodes.map((node) => pigLimit(node.pig)).filter((value) => Number.isFinite(value) && value > 0);
  return {
    status,
    running: sum("running"),
    waiting: sum("waiting"),
    limit: knownLimits.length > 0 ? knownLimits.reduce((total, value) => total + value, 0) : null,
    green_nodes: activeNodes.filter((node) => node.pig?.status === "green").length,
    yellow_nodes: activeNodes.filter((node) => node.pig?.status === "yellow").length,
    red_nodes: activeNodes.filter((node) => node.pig?.status === "red").length,
    error_nodes: activeNodes.filter((node) => node.pig?.ok === false).length
  };
}

function setDeployments(next) {
  deployments = sortedDeployments(next);
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
      hint: "with active Phala nodes",
      tone: "green"
    },
    {
      label: "Selected",
      value: selectedModel ? selectedModel.id : "-",
      hint: selectedModel ? `${fmt(selectedModel.active_phala_deployment_count)} active Phala` : "none",
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
        <span class="pill ${escapeAttr(modelTone(model))}">${escapeHTML(fmt(model.active_phala_deployment_count))} active</span>
      </button>
    `;
  }).join("");
}

function renderDeployments() {
  $("deployments-title").textContent = selectedModel ? "Nodes" : "Phala deployments";
  $("deployments-subtitle").textContent = selectedModel ? `${deployments.length} Phala listings, ${selectedIDs.size} selected` : "select a model";
  if (!selectedModel) {
    $("deployments-body").innerHTML = `<div class="empty">Select a model on the left</div>`;
    return;
  }
  if (deployments.length === 0) {
    $("deployments-body").innerHTML = `<div class="empty">No Phala deployments for this model</div>`;
    return;
  }
  $("deployments-body").innerHTML = deployments.map((deployment) => {
    const selected = selectedDeployment && String(selectedDeployment.id) === String(deployment.id);
    const checked = selectedIDs.has(String(deployment.id));
    const pig = pigForDeployment(deployment.id);
    const tone = deploymentTone(deployment);
    const running = pig?.running;
    return `
      <article class="node-card ${selected ? "selected" : ""} ${deployment.active ? "" : "inactive"}" data-deployment-id="${escapeAttr(deployment.id)}" title="${escapeAttr(shortHost(deploymentBaseURL(deployment)))}">
        <div class="node-card-head">
          <input class="row-check" type="checkbox" data-action="select" ${checked ? "checked" : ""} aria-label="select deployment ${escapeAttr(deployment.id)}">
          <div class="node-card-title">
            <div class="node-title">${escapeHTML(nodeLabel(deploymentBaseURL(deployment)))}</div>
          </div>
          <span class="pill ${escapeAttr(deployment.active ? "green" : "disabled")}">${deployment.active ? "up" : "down"}</span>
        </div>
        <div class="node-running">
          <span>running</span>
          <strong>${escapeHTML(fmt(running))}</strong>
          <span class="pill ${escapeAttr(tone)}">${escapeHTML(pig?.status || "not loaded")}</span>
        </div>
        <div class="row-actions">
          <button data-action="pig" type="button">PIG</button>
          <button data-action="toggle" class="${deployment.active ? "danger" : "primary"}" type="button">
            ${deployment.active ? "Down" : "Up"}
          </button>
        </div>
      </article>
    `;
  }).join("");
}

function timeLabel(value) {
  if (!Number.isFinite(Number(value))) return "-";
  return new Date(value).toLocaleTimeString([], { hour12: false });
}

function chartGeometry(width, height) {
  const padding = { left: 58, right: 22, top: 34, bottom: 40 };
  return {
    padding,
    plotW: Math.max(1, width - padding.left - padding.right),
    plotH: Math.max(1, height - padding.top - padding.bottom)
  };
}

function colorForNode(id, fallbackIndex = 0) {
  const index = Math.abs(String(id ?? fallbackIndex).split("").reduce((sum, ch) => sum + ch.charCodeAt(0), fallbackIndex));
  return STACK_COLORS[index % STACK_COLORS.length];
}

function numericPointValue(point, key) {
  const value = Number(point?.[key]);
  return Number.isFinite(value) ? value : null;
}

function maxHistoryValue() {
  return Math.max(1, ...runningHistory.map((point) => Math.max(
    numericPointValue(point, "running") || (point.nodes || []).reduce((sum, node) => sum + Number(node.running || 0), 0),
    numericPointValue(point, "limit") || 0,
    numericPointValue(point, "waiting") || 0
  )));
}

function valueToY(value, maxValue, padding, plotH) {
  return padding.top + plotH - (plotH * Number(value || 0) / maxValue);
}

function chartTimeDomain(now = Date.now()) {
  return { start: now - CHART_WINDOW_MS, end: now };
}

function timeToX(value, domain, padding, plotW) {
  const ratio = (Number(value) - domain.start) / Math.max(1, domain.end - domain.start);
  return padding.left + (plotW * Math.max(0, Math.min(1, ratio)));
}

function xToTime(value, domain, padding, plotW) {
  const ratio = (Number(value) - padding.left) / Math.max(1, plotW);
  return domain.start + ((domain.end - domain.start) * Math.max(0, Math.min(1, ratio)));
}

function buildHistoryPoint(summary, nodes) {
  const nodeByID = new Map((nodes || []).map((node) => [String(node.deployment_id), node]));
  const orderedNodes = deployments.length > 0
    ? deployments.map((deployment) => nodeByID.get(String(deployment.id))).filter(Boolean)
    : (nodes || []);
  const activeNodes = orderedNodes.filter((node) => node.active);
  const stacks = activeNodes.map((node, index) => ({
    id: node.deployment_id,
    label: nodeLabel(node.base_url),
    running: Number(node.pig?.running || 0),
    status: node.pig?.status || "unknown",
    color: colorForNode(node.deployment_id, index)
  }));
  return {
    at: Date.now(),
    running: Number(summary?.running || stacks.reduce((sum, node) => sum + node.running, 0)),
    waiting: Number(summary?.waiting || 0),
    limit: Number.isFinite(Number(summary?.limit)) ? Number(summary.limit) : null,
    nodes: stacks
  };
}

function drawChart() {
  const canvas = $("running-chart");
  const tooltip = $("chart-tooltip");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(320, Math.floor(rect.width));
  const height = Math.max(180, Math.floor(rect.height));
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr;
    canvas.height = height * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "rgba(10, 16, 15, 0.94)";
  ctx.fillRect(0, 0, width, height);

  const { padding, plotW, plotH } = chartGeometry(width, height);
  const maxValue = maxHistoryValue();
  const domain = chartTimeDomain();
  ctx.strokeStyle = "rgba(146, 170, 161, 0.22)";
  ctx.lineWidth = 1;
  ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

  for (let i = 0; i <= 4; i += 1) {
    const y = padding.top + (plotH * i / 4);
    const value = Math.round((4 - i) * maxValue / 4);
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
    ctx.fillStyle = "rgba(197, 215, 208, 0.66)";
    ctx.fillText(String(value), 14, y + 4);
  }

  for (let i = 0; i <= 5; i += 1) {
    const x = padding.left + (plotW * i / 5);
    const tickTime = domain.start + (CHART_WINDOW_MS * i / 5);
    ctx.beginPath();
    ctx.moveTo(x, padding.top);
    ctx.lineTo(x, height - padding.bottom);
    ctx.stroke();
    ctx.fillStyle = "rgba(197, 215, 208, 0.58)";
    ctx.fillText(timeLabel(tickTime), Math.max(8, Math.min(width - 86, x - 28)), height - 14);
  }

  drawStackedBars(ctx, width, height, padding, maxValue, domain);
  drawLineSeries(ctx, width, height, padding, maxValue, domain, "limit", "rgba(197, 215, 208, 0.72)", [6, 5]);
  drawLineSeries(ctx, width, height, padding, maxValue, domain, "waiting", "#ff5263");
  drawChartHover(ctx, width, height, padding, plotW, plotH, maxValue, domain, tooltip);

  ctx.fillStyle = "rgba(238, 248, 244, 0.86)";
  ctx.fillText(`max ${fmt(maxValue)}`, padding.left, 18);
  ctx.fillStyle = "rgba(197, 215, 208, 0.86)";
  ctx.fillText("stacked running by node", padding.left + 86, 18);
  ctx.fillStyle = "#ff5263";
  ctx.fillText("waiting", Math.min(width - 82, padding.left + 252), 18);
  drawStackLegend(ctx, width, padding);
}

function drawStackedBars(ctx, width, height, padding, maxValue, domain) {
  const points = runningHistory;
  if (points.length === 0) return;
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;
  const step = plotW / MAX_HISTORY_POINTS;
  const barW = Math.max(2, Math.min(12, step * 0.76));
  points.forEach((point) => {
    const x = timeToX(point.at, domain, padding, plotW) - (barW / 2);
    let runningBase = 0;
    for (const node of point.nodes || []) {
      const value = Number(node.running || 0);
      if (!Number.isFinite(value) || value <= 0) continue;
      const y1 = valueToY(runningBase, maxValue, padding, plotH);
      runningBase += value;
      const y2 = valueToY(runningBase, maxValue, padding, plotH);
      ctx.fillStyle = node.color || colorForNode(node.id);
      ctx.fillRect(Math.max(padding.left, x), y2, Math.min(barW, width - padding.right - x), Math.max(1, y1 - y2));
    }
  });
}

function drawLineSeries(ctx, width, height, padding, maxValue, domain, key, color, dash = []) {
  const points = runningHistory;
  if (points.length < 2) return;
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.setLineDash(dash);
  ctx.beginPath();
  let started = false;
  points.forEach((point) => {
    const value = numericPointValue(point, key);
    if (value === null) {
      started = false;
      return;
    }
    const x = timeToX(point.at, domain, padding, plotW);
    const y = valueToY(value, maxValue, padding, plotH);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawStackLegend(ctx, width, padding) {
  const latest = runningHistory.at(-1);
  if (!latest?.nodes?.length) return;
  let x = padding.left;
  let y = padding.top - 10;
  const maxX = width - padding.right;
  ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  for (const node of latest.nodes.slice(0, 8)) {
    const label = node.label || String(node.id || "-");
    const itemW = Math.min(96, 18 + ctx.measureText(label).width);
    if (x + itemW > maxX) break;
    ctx.fillStyle = node.color || colorForNode(node.id);
    ctx.fillRect(x, y - 7, 8, 8);
    ctx.fillStyle = "rgba(197, 215, 208, 0.68)";
    ctx.fillText(label, x + 12, y);
    x += itemW + 10;
  }
}

function nearestHistoryPoint(time) {
  if (runningHistory.length === 0) return null;
  let best = runningHistory[0];
  let bestDistance = Math.abs(Number(best.at) - Number(time));
  for (const point of runningHistory.slice(1)) {
    const distance = Math.abs(Number(point.at) - Number(time));
    if (distance < bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  return best;
}

function drawChartHover(ctx, width, height, padding, plotW, plotH, maxValue, domain, tooltip) {
  if (!tooltip || !chartHover || runningHistory.length === 0) {
    if (tooltip) tooltip.hidden = true;
    return;
  }
  const point = nearestHistoryPoint(chartHover.time);
  if (!point) {
    tooltip.hidden = true;
    return;
  }
  const x = timeToX(point.at, domain, padding, plotW);
  const y = Math.max(padding.top, Math.min(height - padding.bottom, chartHover.y));
  ctx.strokeStyle = "rgba(238, 248, 244, 0.42)";
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 4]);
  ctx.beginPath();
  ctx.moveTo(x, padding.top);
  ctx.lineTo(x, height - padding.bottom);
  ctx.moveTo(padding.left, y);
  ctx.lineTo(width - padding.right, y);
  ctx.stroke();
  ctx.setLineDash([]);

  for (const [key, color] of [["limit", "#91aaa1"], ["waiting", "#ff5263"]]) {
    const value = numericPointValue(point, key);
    if (value === null) continue;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, valueToY(value, maxValue, padding, plotH), 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  const rows = (point.nodes || [])
    .filter((node) => Number(node.running || 0) > 0)
    .sort((a, b) => Number(b.running || 0) - Number(a.running || 0))
    .map((node) => `<span><b style="background:${escapeAttr(node.color || colorForNode(node.id))}"></b>${escapeHTML(node.label)} ${escapeHTML(fmt(node.running, 0))}</span>`)
    .join("");
  tooltip.hidden = false;
  tooltip.innerHTML = `
    <div>${escapeHTML(timeLabel(point.at))}</div>
    <span><b class="green-dot"></b>total ${escapeHTML(fmt(point.running))}</span>
    <span><b class="muted-dot"></b>limit ${escapeHTML(fmt(point.limit))}</span>
    <span><b class="red-dot"></b>waiting ${escapeHTML(fmt(point.waiting))}</span>
    ${rows || "<span>no active running nodes</span>"}
  `;
  tooltip.style.transform = `translate(${Math.min(width - 218, Math.max(10, x + 12))}px, ${Math.min(height - 168, Math.max(10, y + 12))}px)`;
}

function renderPigPanel() {
  const summary = pigSummary();
  $("pig-panel-title").textContent = selectedModel ? `PIG: ${selectedModel.model_id}` : "PIG runtime";
  $("pig-panel-subtitle").textContent = `${summary.status} | running ${fmt(summary.running)} / ${fmt(summary.limit)} | waiting ${fmt(summary.waiting)}`;
  drawChart();

  const node = selectedPigNode();
  $("pig-policy-target").textContent = selectedDeployment ? shortHost(deploymentBaseURL(selectedDeployment)) : "select a Phala node";
  $("pig-policy-refresh-btn").disabled = !selectedDeployment;
  $("pig-policy-save-btn").disabled = !selectedDeployment || !latestPolicy || String(latestPolicy.deployment_id) !== String(selectedDeployment.id);
  if (!selectedDeployment) return;
  if (!latestPolicy || String(latestPolicy.deployment_id) !== String(selectedDeployment.id)) {
    for (const id of ["pig-window-concurrency", "pig-running-limit"]) {
      $(id).disabled = true;
      $(id).closest("label").hidden = true;
    }
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
  const data = await api(`/api/models?q=${q}${force ? "&force=true" : ""}`);
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
  deployments = sortedDeployments(data.deployments);
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
    runningHistory.push(buildHistoryPoint(summary, pigNodes));
    const cutoff = Date.now() - CHART_WINDOW_MS;
    runningHistory = runningHistory.filter((point) => Number(point.at) >= cutoff).slice(-MAX_HISTORY_POINTS);
    render();
  } catch (err) {
    log(`PIG refresh failed: ${err.message}`, "err");
  } finally {
    pigRefreshInFlight = false;
    pigTimer = window.setTimeout(() => refreshPig(false), PIG_REFRESH_MS);
  }
}

function updateChartHover(event) {
  const canvas = $("running-chart");
  if (!canvas || runningHistory.length === 0) return;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(320, Math.floor(rect.width));
  const height = Math.max(180, Math.floor(rect.height));
  const { padding, plotW } = chartGeometry(width, height);
  const localX = Math.max(padding.left, Math.min(width - padding.right, event.clientX - rect.left));
  const localY = Math.max(padding.top, Math.min(height - padding.bottom, event.clientY - rect.top));
  chartHover = {
    time: xToTime(localX, chartTimeDomain(), padding, plotW),
    y: localY
  };
  drawChart();
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
    base_url: deploymentBaseURL(deployment),
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
  const governor = policy.reference_semantics === "soft_target" && typeof policy.epoch === "string";
  for (const id of ["pig-window-concurrency", "pig-running-limit"]) {
    $(id).disabled = governor;
    $(id).closest("label").hidden = governor;
  }
  $("pig-tps-reference").value = mutable.tps_reference ?? "";
  $("pig-window-concurrency").value = mutable.window_concurrency ?? "";
  $("pig-running-limit").value = mutable.running_limit ?? "";
  $("pig-policy-revision").textContent = fmt(policy.revision);
  $("pig-policy-source").textContent = governor ? "Governor" : policy.source || "-";
  $("pig-policy-mode").textContent = governor ? "soft TPS target" : effective.admission_mode || "-";
  $("pig-policy-message").textContent = governor
    ? `epoch ${policy.epoch} | average TPS ${policy.average_tps == null ? "-" : fmt(policy.average_tps)} | decode sequences ${fmt(policy.active_decode_sequences)}`
    : `loaded revision ${fmt(policy.revision)}; ${policy.persistence || "runtime"}`;
  $("pig-policy-message").className = "subline mono ok";
}

async function readPigPolicy() {
  if (!selectedModel || !selectedDeployment) throw new Error("select a Phala deployment first");
  $("pig-policy-message").textContent = "reading policy...";
  $("pig-policy-message").className = "subline mono";
  const deploymentID = selectedDeployment.id;
  const policy = await api(`/api/pig-policy?model_id=${encodeURIComponent(selectedModel.id)}&deployment_id=${encodeURIComponent(deploymentID)}`);
  if (String(selectedDeployment?.id) !== String(deploymentID)) return policy;
  loadPolicyIntoForm(policy);
  renderPigPanel();
  return policy;
}

async function savePigPolicy() {
  if (!selectedModel || !selectedDeployment) throw new Error("select a Phala deployment first");
  if (!latestPolicy || String(latestPolicy.deployment_id) !== String(selectedDeployment.id)) throw new Error("Load policy before saving");
  const governor = latestPolicy.reference_semantics === "soft_target" && typeof latestPolicy.epoch === "string";
  const payload = {
    tps_reference: parsePolicyInteger($("pig-tps-reference").value, "TPS reference", 0, 1000000),
    window_concurrency: governor ? undefined : parsePolicyInteger($("pig-window-concurrency").value, "Window concurrency", 1, 1000000),
    running_limit: governor ? undefined : parsePolicyInteger($("pig-running-limit").value, "Running limit", 0, 1000000)
  };
  if (governor) {
    delete payload.window_concurrency;
    delete payload.running_limit;
    payload.expected_epoch = latestPolicy.epoch;
  }
  const revision = Number(latestPolicy?.revision);
  if (Number.isFinite(revision) && revision > 0) payload.expected_revision = revision;
  if (!confirmWrite(`Save PIG hot policy for #${selectedDeployment.id}?`, payload)) return;
  const deploymentID = selectedDeployment.id;
  $("pig-policy-message").textContent = "saving policy...";
  $("pig-policy-message").className = "subline mono";
  let policy;
  try {
    policy = await api(`/api/pig-policy?model_id=${encodeURIComponent(selectedModel.id)}&deployment_id=${encodeURIComponent(selectedDeployment.id)}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
    });
  } catch (err) {
    if (String(selectedDeployment?.id) === String(deploymentID)) {
      latestPolicy = null;
      renderPigPanel();
      $("pig-policy-message").textContent = `Save not confirmed: ${err.message}. Load policy before retrying.`;
      $("pig-policy-message").className = "subline mono err";
    }
    throw err;
  }
  if (String(selectedDeployment?.id) !== String(deploymentID)) return;
  loadPolicyIntoForm(policy);
  log(`PIG policy saved for ${shortHost(deploymentBaseURL(selectedDeployment))} revision ${fmt(policy.revision)}`, "ok");
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
$("refresh-btn").addEventListener("click", () => refreshRedpill(true));
$("pig-refresh-btn").addEventListener("click", () => refreshPig(true));
$("select-active-btn").addEventListener("click", () => selectBy((deployment) => deployment.active));
$("select-inactive-btn").addEventListener("click", () => selectBy((deployment) => !deployment.active));
$("clear-selection-btn").addEventListener("click", () => selectBy(() => false));
$("bulk-up-btn").addEventListener("click", () => bulkSetActive(true).catch((err) => log(err.message, "err")));
$("bulk-down-btn").addEventListener("click", () => bulkSetActive(false).catch((err) => log(err.message, "err")));
$("clear-log-btn").addEventListener("click", () => {
  $("log").textContent = "";
  $("log").className = "";
  logEntryCount = 0;
  lastLogLine = "";
  lastLogTone = "";
  updateLogPanel();
});
$("log-toggle-btn").addEventListener("click", () => {
  logExpanded = !logExpanded;
  updateLogPanel();
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

$("running-chart").addEventListener("mousemove", updateChartHover);
$("running-chart").addEventListener("mouseleave", () => {
  chartHover = null;
  drawChart();
});
window.addEventListener("resize", drawChart);

refreshRedpill(true);
updateLogPanel();
pigTimer = window.setTimeout(() => refreshPig(false), PIG_REFRESH_MS);
