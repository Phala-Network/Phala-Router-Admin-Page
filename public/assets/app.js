"use strict";

let routers = [];
let selectedId = "";
let latestSnapshot = null;
let refreshInFlight = false;
let topologyGraph = null;
let topologyGraphReady = false;
let topologyGraphContainer = null;
let topologyParticlesLayer = null;
let topologyResizeObserver = null;
let topologyNodePositions = new Map();
let topologyPinnedNodes = new Set();
let topologyGraphSignature = "";
let topologyLastParticleAt = 0;

const $ = (id) => document.getElementById(id);
const THEMES = new Set(["phala-terminal", "vast-console", "clean-ops", "signal-board", "mesh-topology"]);
const TOPOLOGY_ZOOM_PADDING = 135;

function preferredTheme() {
  const saved = localStorage.getItem("phala-router-admin-theme");
  return THEMES.has(saved) ? saved : "phala-terminal";
}

function applyTheme(theme) {
  const next = THEMES.has(theme) ? theme : "phala-terminal";
  document.body.dataset.theme = next;
  $("theme-select").value = next;
  localStorage.setItem("phala-router-admin-theme", next);
  if (next !== "mesh-topology") setEditorOpen(false);
  if (topologyGraph) {
    if (next === "mesh-topology") topologyGraph.resumeAnimation();
    else topologyGraph.pauseAnimation();
  }
  window.setTimeout(() => {
    resizeTopologyGraph();
    if (next === "mesh-topology" && latestSnapshot) renderTopology(latestSnapshot);
  }, 0);
}

function currentRouterId() {
  const select = $("router-select");
  return select.value || localStorage.getItem("phala-router-admin-selected") || (routers[0] && routers[0].id) || "";
}

function requestURL(path) {
  const url = new URL(path, window.location.origin);
  url.username = "";
  url.password = "";
  return url.toString();
}

async function api(path, options = {}) {
  const url = new URL(requestURL(path));
  if (path.indexOf("?") >= 0) {
    const raw = new URL(path, window.location.origin);
    raw.searchParams.forEach((value, key) => url.searchParams.set(key, value));
  }
  url.searchParams.set("router", currentRouterId());
  const response = await fetch(url.toString(), {
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
  if (!response.ok) {
    throw new Error(typeof data === "string" ? data : JSON.stringify(data));
  }
  return data;
}

function setStatus(text) {
  $("status-line").textContent = text;
}

function log(value, klass) {
  const el = $("log");
  el.textContent = value || "";
  el.className = klass || "";
}

function fmt(value) {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "number") {
    if (Math.abs(value) >= 100) return String(Math.round(value));
    if (Math.abs(value) >= 10) return value.toFixed(1).replace(/\.0$/, "");
    return value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  }
  return String(value);
}

function pct(value, limit) {
  const v = Number(value);
  const l = Number(limit);
  if (!Number.isFinite(v) || !Number.isFinite(l) || l <= 0) return 0;
  return Math.max(0, Math.min(100, (v / l) * 100));
}

function metricLevel(value, limit, options = {}) {
  const waiting = Number(options.waiting || 0);
  if (Number.isFinite(waiting) && waiting > 0) return "pressure";
  const p = pct(value, limit);
  if (p >= 95) return "red";
  if (p >= 75) return "yellow";
  return "green";
}

function meter(value, limit, subline, options = {}) {
  const waiting = Number(options.waiting || 0);
  const hasPressure = Number.isFinite(waiting) && waiting > 0;
  const rawPct = pct(value, limit);
  const p = hasPressure ? (rawPct > 0 ? Math.max(8, rawPct) : 100) : rawPct;
  const klass = metricLevel(value, limit, options);
  return `
    <div class="metric-head">
      <span class="mono metric-value">${fmt(value)}${limit !== null && limit !== undefined ? " / " + fmt(limit) : ""}</span>
      ${hasPressure ? `<span class="meter-chip pressure">waiting ${fmt(waiting)}</span>` : ""}
    </div>
    <div class="bar ${klass}" style="--w:${p}%"><span></span></div>
    ${subline ? `<div class="subline mono metric-subline">${subline}</div>` : ""}
  `;
}

function selectionCell(route) {
  return `
    <div class="mono">cache ${fmt(route?.selected_by_cache || 0)}</div>
    <div class="mono">load ${fmt(route?.selected_by_load || 0)}</div>
    <div class="mono">order ${fmt(route?.selected_by_order || 0)}</div>
  `;
}

function renderSummary(summary) {
  const items = [
    { label: "nodes", value: summary.nodes, tone: "neutral", hint: "configured" },
    { label: "enabled", value: summary.enabled_nodes, tone: "green" },
    { label: "router run", value: summary.router_running, tone: Number(summary.router_running || 0) > 0 ? "blue" : "neutral" },
    { label: "PIG run", value: summary.pig_running, tone: Number(summary.waiting || 0) > 0 ? "pressure" : "green" },
    { label: "backend run", value: summary.backend_running, tone: Number(summary.waiting || 0) > 0 ? "pressure" : "green" },
    { label: "waiting", value: summary.waiting, tone: Number(summary.waiting || 0) > 0 ? "pressure" : "neutral" },
    { label: "cache", value: summary.cache_selected, tone: Number(summary.cache_selected || 0) > 0 ? "blue" : "neutral" },
    { label: "load", value: summary.load_selected, tone: Number(summary.load_selected || 0) > 0 ? "yellow" : "neutral" }
  ];
  $("summary").innerHTML = items.map(({ label, value, tone, hint }) => `
    <div class="stat ${tone}">
      <div class="label">${label}</div>
      <div class="value">${fmt(value)}</div>
      <div class="stat-hint">${hint || tone}</div>
    </div>
  `).join("");
}

function renderNode(node) {
  const route = node.route || {};
  const pig = node.runtime?.pig || {};
  const backend = node.runtime?.backend || {};
  const routerLimit = pig.global_limit ?? backend.running ?? route.running;
  const pigWaiting = pig.waiting ?? backend.waiting ?? 0;
  const backendWaiting = backend.waiting ?? pig.waiting ?? 0;
  const publicModel = Object.keys(node.models || {})[0] || "";
  const upstreamModel = publicModel ? node.models[publicModel] : "";
  const enabledClass = node.enabled ? "enabled" : "disabled";
  const healthStatus = node.health?.status || "unknown";
  const healthReason = node.health?.reason || "";
  return `
    <tr data-node="${escapeAttr(node.name)}">
      <td><button class="switch ${enabledClass}" data-action="toggle">${node.enabled ? "enabled" : "disabled"}</button></td>
      <td>
        <div class="node-title">${escapeHTML(node.name)}</div>
        <div class="subline mono">${escapeHTML(publicModel)}${upstreamModel ? " -> " + escapeHTML(upstreamModel) : ""}</div>
      </td>
      <td>
        <div class="mono subline">${escapeHTML(node.base_url || "")}</div>
        <div class="subline">${escapeHTML(node.provider || "")}</div>
      </td>
      <td>${node.enabled ? meter(pig.running, pig.global_limit, "", { waiting: pigWaiting }) : meter(null, null)}</td>
      <td>${node.enabled ? meter(backend.running, pig.global_limit, `waiting ${fmt(backend.waiting)} kv ${fmt(backend.kv_usage)}`, { waiting: backendWaiting }) : meter(null, null, "waiting - kv -")}</td>
      <td>${meter(route.running || 0, routerLimit, `processed ${fmt(route.processed || 0)}`)}</td>
      <td>${selectionCell(route)}</td>
      <td><span class="pill ${escapeAttr(healthStatus)}">${escapeHTML(healthStatus)}</span>${healthReason ? `<div class="subline">${escapeHTML(healthReason)}</div>` : ""}</td>
      <td>
        <div class="row-actions">
          <button data-action="load">load</button>
          <button class="danger" data-action="delete">delete</button>
        </div>
      </td>
    </tr>
  `;
}

function renderNodeCard(node) {
  const route = node.route || {};
  const pig = node.runtime?.pig || {};
  const backend = node.runtime?.backend || {};
  const routerLimit = pig.global_limit ?? backend.running ?? route.running;
  const pigWaiting = pig.waiting ?? backend.waiting ?? 0;
  const backendWaiting = backend.waiting ?? pig.waiting ?? 0;
  const publicModel = Object.keys(node.models || {})[0] || "";
  const upstreamModel = publicModel ? node.models[publicModel] : "";
  const enabledClass = node.enabled ? "enabled" : "disabled";
  const healthStatus = node.health?.status || "unknown";
  const healthReason = node.health?.reason || "";
  return `
    <article class="node-card ${enabledClass} ${escapeAttr(healthStatus)}" data-node="${escapeAttr(node.name)}">
      <div class="node-card-top">
        <div>
          <div class="node-title">${escapeHTML(node.name)}</div>
          <div class="subline mono">${escapeHTML(publicModel)}${upstreamModel ? " -> " + escapeHTML(upstreamModel) : ""}</div>
        </div>
        <button class="switch ${enabledClass}" data-action="toggle">${node.enabled ? "enabled" : "disabled"}</button>
      </div>
      <div class="node-card-endpoint">
        <div class="mono">${escapeHTML(node.base_url || "")}</div>
        <div>${escapeHTML(node.provider || "")}</div>
      </div>
      <div class="node-card-metrics">
        <div class="card-meter">
          <div class="card-meter-title">PIG run</div>
          ${node.enabled ? meter(pig.running, pig.global_limit, "", { waiting: pigWaiting }) : meter(null, null)}
        </div>
        <div class="card-meter">
          <div class="card-meter-title">Backend</div>
          ${node.enabled ? meter(backend.running, pig.global_limit, `waiting ${fmt(backend.waiting)} kv ${fmt(backend.kv_usage)}`, { waiting: backendWaiting }) : meter(null, null, "waiting - kv -")}
        </div>
        <div class="card-meter">
          <div class="card-meter-title">Router</div>
          ${meter(route.running || 0, routerLimit, `processed ${fmt(route.processed || 0)}`)}
        </div>
      </div>
      <div class="node-card-footer">
        <div class="card-selection mono">
          <span>cache ${fmt(route.selected_by_cache || 0)}</span>
          <span>load ${fmt(route.selected_by_load || 0)}</span>
          <span>order ${fmt(route.selected_by_order || 0)}</span>
        </div>
        <div>
          <span class="pill ${escapeAttr(healthStatus)}">${escapeHTML(healthStatus)}</span>
          ${healthReason ? `<div class="subline">${escapeHTML(healthReason)}</div>` : ""}
        </div>
      </div>
      <div class="row-actions node-card-actions">
        <button data-action="load">load</button>
        <button class="danger" data-action="delete">delete</button>
      </div>
    </article>
  `;
}

function nodeTone(node) {
  const pig = node.runtime?.pig || {};
  const backend = node.runtime?.backend || {};
  const waiting = Number(pig.waiting ?? backend.waiting ?? 0);
  const healthStatus = node.health?.status || "unknown";
  if (!node.enabled || healthStatus === "disabled") return "disabled";
  if (waiting > 0 || healthStatus === "metrics_error") return "pressure";
  const running = pig.running ?? backend.running ?? node.route?.running;
  const limit = pig.global_limit ?? backend.global_limit;
  return metricLevel(running, limit);
}

function setEditorOpen(open) {
  document.body.classList.toggle("editor-open", Boolean(open));
}

function cssValue(name) {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}

function topologyColor(tone) {
  if (tone === "pressure" || tone === "red") return cssValue("--red");
  if (tone === "yellow") return cssValue("--yellow");
  if (tone === "blue") return cssValue("--blue");
  if (tone === "disabled") return cssValue("--muted");
  return cssValue("--primary");
}

function colorWithAlpha(color, alpha) {
  const hex = String(color || "").trim();
  const short = hex.match(/^#([0-9a-f]{3})$/i);
  if (short) {
    const [r, g, b] = short[1].split("").map((part) => parseInt(part + part, 16));
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const full = hex.match(/^#([0-9a-f]{6})$/i);
  if (full) {
    const value = full[1];
    const r = parseInt(value.slice(0, 2), 16);
    const g = parseInt(value.slice(2, 4), 16);
    const b = parseInt(value.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}

function topologyNodeMetrics(node) {
  const route = node.route || {};
  const pig = node.runtime?.pig || {};
  const backend = node.runtime?.backend || {};
  const running = Number(pig.running ?? backend.running ?? route.running ?? 0);
  const limit = pig.global_limit ?? backend.global_limit ?? route.limit ?? null;
  const waiting = Number(pig.waiting ?? backend.waiting ?? 0);
  const publicModel = Object.keys(node.models || {})[0] || "";
  return {
    route,
    pig,
    backend,
    running,
    limit,
    waiting,
    publicModel,
    upstreamModel: publicModel ? node.models[publicModel] : "",
    loadPercent: pct(running, limit),
    tone: nodeTone(node)
  };
}

function summaryStats(summary) {
  return [
    { label: "nodes", value: summary.nodes, tone: "neutral" },
    { label: "enabled", value: summary.enabled_nodes, tone: "green" },
    { label: "router", value: summary.router_running, tone: Number(summary.router_running || 0) > 0 ? "blue" : "neutral" },
    { label: "PIG", value: summary.pig_running, tone: Number(summary.waiting || 0) > 0 ? "pressure" : "green" },
    { label: "backend", value: summary.backend_running, tone: Number(summary.waiting || 0) > 0 ? "pressure" : "green" },
    { label: "waiting", value: summary.waiting, tone: Number(summary.waiting || 0) > 0 ? "pressure" : "neutral" },
    { label: "cache", value: summary.cache_selected, tone: "blue" },
    { label: "load", value: summary.load_selected, tone: "yellow" }
  ];
}

function drawRoundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawCenteredText(ctx, text, x, y, width, font, color) {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const value = String(text ?? "");
  let out = value;
  while (ctx.measureText(out).width > width && out.length > 4) out = `${out.slice(0, -4)}...`;
  ctx.fillText(out, x, y);
}

function drawLoadRing(ctx, x, y, radius, percent, tone) {
  const color = topologyColor(tone);
  const track = cssValue("--track");
  const lineWidth = 8;
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = track;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(x, y, radius, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * Math.min(100, Math.max(0, percent))) / 100);
  ctx.stroke();
  ctx.lineCap = "butt";
}

function drawDisabledRing(ctx, x, y, radius) {
  const muted = cssValue("--muted");
  ctx.save();
  ctx.setLineDash([8, 7]);
  ctx.lineWidth = 7;
  ctx.strokeStyle = colorWithAlpha(muted, 0.58);
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([2, 10]);
  ctx.lineWidth = 2;
  ctx.strokeStyle = colorWithAlpha(muted, 0.78);
  ctx.beginPath();
  ctx.arc(x, y, radius + 10, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawCoreNode(node, ctx) {
  const x = node.x;
  const y = node.y;
  const radius = 140;
  const primary = cssValue("--primary");
  const surface = cssValue("--surface");
  const surface2 = cssValue("--surface-2");
  const line = cssValue("--line");
  const text = cssValue("--text");
  const muted = cssValue("--muted");
  const stats = summaryStats(node.summary || {});

  const glow = ctx.createRadialGradient(x, y, radius * 0.18, x, y, radius);
  glow.addColorStop(0, "rgba(53, 243, 199, 0.20)");
  glow.addColorStop(1, "rgba(13, 20, 32, 0.96)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = primary;
  ctx.stroke();

  ctx.setLineDash([10, 8]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(53, 243, 199, 0.34)";
  ctx.beginPath();
  ctx.arc(x, y, radius + 18, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  drawCenteredText(ctx, "ROUTER CORE", x, y - 76, 160, "800 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", primary);
  drawCenteredText(ctx, node.label || "active", x, y - 52, 176, "800 17px Inter, system-ui, sans-serif", text);

  const cellW = 56;
  const cellH = 26;
  const gap = 6;
  const rowSizes = [3, 3, 2];
  const startY = y - 17;
  stats.forEach((stat, index) => {
    let row = 0;
    let offset = index;
    while (row < rowSizes.length - 1 && offset >= rowSizes[row]) {
      offset -= rowSizes[row];
      row += 1;
    }
    const col = offset;
    const rowCount = rowSizes[row] || rowSizes[rowSizes.length - 1];
    const rowWidth = rowCount * cellW + (rowCount - 1) * gap;
    const cx = x - rowWidth / 2 + col * (cellW + gap);
    const cy = startY + row * (cellH + gap);
    drawRoundedRect(ctx, cx, cy, cellW, cellH, 6);
    ctx.fillStyle = surface2;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = stat.tone === "neutral" ? line : topologyColor(stat.tone);
    ctx.stroke();
    drawCenteredText(ctx, stat.label, cx + cellW / 2, cy + 8, cellW - 8, "800 7px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", muted);
    drawCenteredText(ctx, fmt(stat.value), cx + cellW / 2, cy + 20, cellW - 8, "800 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", text);
  });

  ctx.fillStyle = surface;
}

function drawUpstreamNode(node, ctx) {
  const x = node.x;
  const y = node.y;
  const metrics = node.metrics || {};
  const radius = 74;
  const ringRadius = radius + 8;
  const tone = metrics.tone || "green";
  const disabled = tone === "disabled" || !node.enabled;
  const surface = cssValue("--surface-2");
  const text = cssValue("--text");
  const muted = cssValue("--muted");
  const mutedStrong = cssValue("--muted-strong");
  const color = topologyColor(tone);

  if (disabled) drawDisabledRing(ctx, x, y, ringRadius);
  else drawLoadRing(ctx, x, y, ringRadius, metrics.loadPercent || 0, tone);

  ctx.fillStyle = disabled
    ? colorWithAlpha(surface, 0.54)
    : tone === "pressure" || tone === "red" ? "rgba(255, 79, 110, 0.13)" : surface;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = disabled ? colorWithAlpha(muted, 0.70) : color;
  if (disabled) ctx.setLineDash([6, 6]);
  ctx.stroke();
  ctx.setLineDash([]);

  if (disabled) {
    ctx.strokeStyle = colorWithAlpha(muted, 0.72);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - 38, y - 38);
    ctx.lineTo(x + 38, y + 38);
    ctx.stroke();
  }

  drawCenteredText(ctx, node.label, x, y - 30, 118, "800 13px Inter, system-ui, sans-serif", disabled ? mutedStrong : text);
  drawCenteredText(ctx, metrics.publicModel || "-", x, y - 11, 112, "700 8px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", muted);
  if (disabled) {
    const badgeW = 80;
    const badgeH = 22;
    drawRoundedRect(ctx, x - badgeW / 2, y + 4, badgeW, badgeH, 6);
    ctx.fillStyle = colorWithAlpha(muted, 0.18);
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = colorWithAlpha(muted, 0.72);
    ctx.stroke();
    drawCenteredText(ctx, "DISABLED", x, y + 15, badgeW - 10, "900 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", mutedStrong);
  } else {
    drawCenteredText(ctx, `run ${fmt(metrics.running)} / ${fmt(metrics.limit)}`, x, y + 13, 118, "800 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", mutedStrong);
  }
  const route = metrics.route || {};
  const wait = Number(metrics.waiting || 0) > 0 ? ` wait ${fmt(metrics.waiting)}` : "";
  drawCenteredText(ctx, disabled ? "not in routing pool" : `cache ${fmt(route.selected_by_cache || 0)} load ${fmt(route.selected_by_load || 0)}${wait}`, x, y + 35, 118, "700 8px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", muted);
}

function drawTopologyNode(node, ctx) {
  if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) return;
  if (node.type === "core") {
    drawCoreNode(node, ctx);
    return;
  }
  drawUpstreamNode(node, ctx);
}

function paintTopologyPointerArea(node, color, ctx) {
  if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) return;
  const radius = node.type === "core" ? 150 : 92;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function topologyLinkColor(link) {
  if (link.kind === "mesh") return "rgba(91, 157, 255, 0.20)";
  if (link.tone === "disabled") return colorWithAlpha(cssValue("--muted"), 0.38);
  return topologyColor(link.tone || "green");
}

function topologyLinkWidth(link) {
  if (link.kind === "mesh") return 0.7;
  if (link.tone === "disabled") return 1.15;
  return Math.max(1.6, Math.min(5.5, Number(link.running || 0) / 12 + 1.6));
}

function topologyLinkDash(link) {
  if (link.kind === "mesh") return [2, 8];
  if (link.tone === "disabled") return [8, 8];
  return null;
}

function topologyCoreGapForce(minRadius) {
  let graphNodes = [];
  function force(alpha) {
    graphNodes.forEach((node) => {
      if (node.type !== "upstream") return;
      const x = Number.isFinite(node.x) ? node.x : 0;
      const y = Number.isFinite(node.y) ? node.y : 0;
      const distance = Math.max(0.001, Math.hypot(x, y));
      if (distance >= minRadius) return;
      const push = (minRadius - distance) * alpha * 1.2;
      node.vx = (node.vx || 0) + (x / distance) * push;
      node.vy = (node.vy || 0) + (y / distance) * push;
    });
  }
  force.initialize = (nodes) => {
    graphNodes = nodes || [];
  };
  return force;
}

function rememberTopologyPositions() {
  if (!topologyGraph) return;
  const graphData = topologyGraph.graphData();
  (graphData.nodes || []).forEach((node) => {
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) return;
    topologyNodePositions.set(node.id, { x: node.x, y: node.y, fx: node.fx, fy: node.fy });
  });
}

function initialTopologyPosition(index, total) {
  const count = Math.max(1, total);
  const angle = -Math.PI / 2 + (index / count) * Math.PI * 2;
  const radius = count <= 4 ? 260 : 305;
  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius
  };
}

function buildTopologyGraph(snapshot) {
  rememberTopologyPositions();
  const upstreams = snapshot.nodes || [];
  const router = snapshot.selected_router || {};
  const graphNodes = [{
    id: "__router__",
    type: "core",
    label: router.label || router.id || "active",
    summary: snapshot.summary || {},
    fx: 0,
    fy: 0
  }];
  const graphLinks = [];

  upstreams.forEach((node, index) => {
    const saved = topologyNodePositions.get(node.name);
    const initial = initialTopologyPosition(index, upstreams.length);
    const pinned = topologyPinnedNodes.has(node.name);
    const metrics = topologyNodeMetrics(node);
    const graphNode = {
      id: node.name,
      type: "upstream",
      label: node.name,
      enabled: node.enabled,
      raw: node,
      metrics,
      x: saved?.x ?? initial.x,
      y: saved?.y ?? initial.y,
      fx: pinned ? saved?.fx ?? saved?.x : undefined,
      fy: pinned ? saved?.fy ?? saved?.y : undefined
    };
    graphNodes.push(graphNode);
    graphLinks.push({
      source: "__router__",
      target: node.name,
      kind: "route",
      tone: metrics.tone,
      running: metrics.running,
      waiting: metrics.waiting
    });
  });

  const activeNames = upstreams.filter((node) => node.enabled).map((node) => node.name);
  activeNames.forEach((name, index) => {
    if (activeNames.length < 3) return;
    graphLinks.push({
      source: name,
      target: activeNames[(index + 1) % activeNames.length],
      kind: "mesh",
      tone: "blue"
    });
  });

  return { nodes: graphNodes, links: graphLinks };
}

function topologyEndpointId(endpoint) {
  return endpoint && typeof endpoint === "object" ? endpoint.id : endpoint;
}

function topologyLinkKey(link) {
  return `${link.kind}:${topologyEndpointId(link.source)}->${topologyEndpointId(link.target)}`;
}

function topologySignature(graphData) {
  const nodeIds = (graphData.nodes || []).map((node) => node.id).sort();
  const linkIds = (graphData.links || []).map(topologyLinkKey).sort();
  return JSON.stringify({ nodeIds, linkIds });
}

function updateExistingTopologyGraph(nextData) {
  const current = topologyGraph.graphData();
  const nodeById = new Map((current.nodes || []).map((node) => [node.id, node]));
  for (const nextNode of nextData.nodes || []) {
    const currentNode = nodeById.get(nextNode.id);
    if (!currentNode) return false;
    if (nextNode.type === "core") {
      currentNode.label = nextNode.label;
      currentNode.summary = nextNode.summary;
      currentNode.fx = 0;
      currentNode.fy = 0;
      continue;
    }
    currentNode.label = nextNode.label;
    currentNode.enabled = nextNode.enabled;
    currentNode.raw = nextNode.raw;
    currentNode.metrics = nextNode.metrics;
    if (!Number.isFinite(currentNode.x)) currentNode.x = nextNode.x;
    if (!Number.isFinite(currentNode.y)) currentNode.y = nextNode.y;
  }

  const linkByKey = new Map((current.links || []).map((link) => [topologyLinkKey(link), link]));
  for (const nextLink of nextData.links || []) {
    const currentLink = linkByKey.get(topologyLinkKey(nextLink));
    if (!currentLink) return false;
    currentLink.kind = nextLink.kind;
    currentLink.tone = nextLink.tone;
    currentLink.running = nextLink.running;
    currentLink.waiting = nextLink.waiting;
  }
  return true;
}

function requestTopologyRedraw(graph) {
  graph.autoPauseRedraw(false);
  graph.resumeAnimation();
  window.requestAnimationFrame(() => {
    graph.autoPauseRedraw(true);
  });
}

function topologyNodeLabel(node) {
  if (node.type === "core") return "Router core";
  const metrics = node.metrics || {};
  const route = metrics.route || {};
  return `
    <div class="graph-tooltip">
      <strong>${escapeHTML(node.label)}</strong>
      <span>run ${fmt(metrics.running)} / ${fmt(metrics.limit)}</span>
      <span>waiting ${fmt(metrics.waiting)}</span>
      <span>cache ${fmt(route.selected_by_cache || 0)} load ${fmt(route.selected_by_load || 0)}</span>
    </div>
  `;
}

function resizeTopologyGraph() {
  if (!topologyGraph || !topologyGraphContainer) return;
  const canvas = $("topology");
  const width = Math.max(320, canvas.clientWidth || 0);
  const height = Math.max(420, canvas.clientHeight || 0);
  topologyGraph.width(width).height(height);
}

function ensureTopologyGraph() {
  if (topologyGraph) return topologyGraph;
  const canvas = $("topology");
  if (typeof ForceGraph !== "function") {
    canvas.innerHTML = `<div class="topology-error">force-graph bundle failed to load</div>`;
    return null;
  }
  canvas.innerHTML = `
    <div class="topology-grid-layer"></div>
    <div class="topology-graph"></div>
    <div class="topology-cursor-orb"></div>
    <div class="topology-particles"></div>
    <div class="topology-hint mono">drag canvas / scroll zoom / drag nodes / click node to edit</div>
  `;
  topologyGraphContainer = canvas.querySelector(".topology-graph");
  topologyParticlesLayer = canvas.querySelector(".topology-particles");
  topologyGraph = ForceGraph()(topologyGraphContainer)
    .backgroundColor("rgba(0,0,0,0)")
    .nodeId("id")
    .nodeVal((node) => node.type === "core" ? 60 : 22)
    .nodeCanvasObject(drawTopologyNode)
    .nodePointerAreaPaint(paintTopologyPointerArea)
    .nodeLabel(topologyNodeLabel)
    .linkColor(topologyLinkColor)
    .linkWidth(topologyLinkWidth)
    .linkLineDash(topologyLinkDash)
    .linkDirectionalParticles((link) => link.kind === "route" && link.tone !== "disabled" ? 2 : 0)
    .linkDirectionalParticleWidth((link) => link.tone === "pressure" || link.tone === "red" ? 4 : 2.4)
    .linkDirectionalParticleSpeed((link) => link.tone === "pressure" || link.tone === "red" ? 0.014 : 0.007)
    .onNodeClick((node) => {
      if (node.type !== "upstream") {
        setEditorOpen(false);
        return;
      }
      selectedId = node.id;
      loadNode(node.raw);
      setEditorOpen(true);
    })
    .onBackgroundClick(() => setEditorOpen(false))
    .onNodeDragEnd((node) => {
      if (node.type === "core") return;
      node.fx = node.x;
      node.fy = node.y;
      topologyPinnedNodes.add(node.id);
      topologyNodePositions.set(node.id, { x: node.x, y: node.y, fx: node.fx, fy: node.fy });
    });

  topologyGraph.d3Force("charge").strength(-390);
  topologyGraph.d3Force("link")
    .distance((link) => link.kind === "mesh" ? 250 : 295)
    .strength((link) => link.kind === "mesh" ? 0.014 : 0.07);
  topologyGraph.d3Force("center").strength(0.04);
  topologyGraph.d3Force("core-gap", topologyCoreGapForce(255));

  if (window.ResizeObserver) {
    topologyResizeObserver = new ResizeObserver(resizeTopologyGraph);
    topologyResizeObserver.observe(canvas);
  } else {
    window.addEventListener("resize", resizeTopologyGraph);
  }
  resizeTopologyGraph();
  return topologyGraph;
}

function renderTopology(snapshot) {
  const graph = ensureTopologyGraph();
  if (!graph) return;
  const nextData = buildTopologyGraph(snapshot);
  const nextSignature = topologySignature(nextData);
  const structureUnchanged = topologyGraphSignature === nextSignature;
  if (structureUnchanged && updateExistingTopologyGraph(nextData)) {
    requestTopologyRedraw(graph);
    return;
  }

  graph.graphData(nextData);
  topologyGraphSignature = nextSignature;
  resizeTopologyGraph();
  if (!topologyGraphReady) {
    topologyGraphReady = true;
    window.setTimeout(() => graph.zoomToFit(500, TOPOLOGY_ZOOM_PADDING), 180);
  } else {
    window.setTimeout(() => graph.zoomToFit(320, TOPOLOGY_ZOOM_PADDING), 120);
  }
}

function render(snapshot) {
  latestSnapshot = snapshot;
  const nodes = snapshot.nodes || [];
  renderSummary(snapshot.summary || {});
  $("nodes-body").innerHTML = nodes.map(renderNode).join("");
  $("node-cards").innerHTML = nodes.map(renderNodeCard).join("");
  if (document.body.dataset.theme === "mesh-topology") renderTopology(snapshot);
  const router = snapshot.selected_router || {};
  setStatus(`${router.label || router.id || ""} ${router.url || ""} | ${snapshot.generated_at || ""}`.trim());
}

async function loadRouters() {
  setStatus("loading routers...");
  const response = await fetch(requestURL("/api/routers"), { credentials: "same-origin" });
  if (!response.ok) throw new Error(`load routers failed: HTTP ${response.status}`);
  const data = await response.json();
  routers = data.routers || [];
  const select = $("router-select");
  select.innerHTML = routers.map((router) => `<option value="${escapeAttr(router.id)}">${escapeHTML(router.label)} (${escapeHTML(router.url)})</option>`).join("");
  const saved = localStorage.getItem("phala-router-admin-selected");
  if (saved && routers.find((router) => router.id === saved)) select.value = saved;
  if (!select.value && routers[0]) select.value = routers[0].id;
  applyRouterDefaults();
}

function applyRouterDefaults() {
  const router = routers.find((item) => item.id === currentRouterId());
  if (!router) return;
  $("provider").value = router.default_provider || "phala-direct";
  $("public-model").value = router.default_public_model || "";
  $("upstream-model").value = router.default_upstream_model || router.default_public_model || "";
  $("use-shared-bearer").value = String(router.default_use_shared_bearer !== false);
}

async function refresh() {
  if (refreshInFlight || routers.length === 0) return;
  refreshInFlight = true;
  try {
    const snapshot = await api("/api/runtime");
    render(snapshot);
    log("");
  } catch (err) {
    log(err.message, "err");
    setStatus("refresh failed");
  } finally {
    refreshInFlight = false;
  }
}

function nodeById(id) {
  return (latestSnapshot?.nodes || []).find((node) => node.name === id);
}

function loadNode(node) {
  if (!node) return;
  const publicModel = Object.keys(node.models || {})[0] || "";
  $("node-name").value = node.name || "";
  $("base-url").value = node.base_url || "";
  $("provider").value = node.provider || "";
  $("public-model").value = publicModel;
  $("upstream-model").value = publicModel ? node.models[publicModel] : "";
  $("use-shared-bearer").value = String(node.use_shared_bearer !== false);
  $("path").value = node.path || "/v1/chat/completions";
  selectedId = node.name || "";
}

async function saveForm() {
  try {
    const body = {
      name: $("node-name").value.trim(),
      base_url: $("base-url").value.trim(),
      provider: $("provider").value.trim(),
      public_model: $("public-model").value.trim(),
      upstream_model: $("upstream-model").value.trim(),
      use_shared_bearer: $("use-shared-bearer").value === "true",
      path: $("path").value.trim()
    };
    await api("/api/nodes", { method: "POST", body: JSON.stringify(body) });
    log("saved", "ok");
    await refresh();
  } catch (err) {
    log(err.message, "err");
  }
}

async function setEnabled(id, enabled) {
  await api(`/api/nodes/${encodeURIComponent(id)}/enabled`, {
    method: "PATCH",
    body: JSON.stringify({ enabled })
  });
  await refresh();
}

async function deleteNode(id) {
  if (!window.confirm(`Delete node ${id}?`)) return;
  await api(`/api/nodes/${encodeURIComponent(id)}`, { method: "DELETE" });
  await refresh();
}

function loadSelected() {
  if (selectedId) loadNode(nodeById(selectedId));
}

function showRawConfig() {
  const upstreams = (latestSnapshot?.nodes || []).map((node) => {
    const out = {
      name: node.name,
      enabled: node.enabled,
      provider: node.provider || "phala-direct",
      base_url: node.base_url,
      models: node.models || {},
      use_shared_bearer: node.use_shared_bearer !== false
    };
    if (node.path) out.path = node.path;
    return out;
  });
  $("raw-json").value = JSON.stringify(upstreams, null, 2);
  $("raw-json").focus();
}

async function saveRaw() {
  try {
    JSON.parse($("raw-json").value);
    const data = await api("/api/upstreams", { method: "PUT", body: $("raw-json").value });
    log(JSON.stringify(data, null, 2), "ok");
    await refresh();
  } catch (err) {
    log(err.message, "err");
  }
}

function topologyPoint(event) {
  const canvas = $("topology");
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top
  };
}

function updateTopologyCursor(event) {
  if (document.body.dataset.theme !== "mesh-topology") return;
  const canvas = $("topology");
  const point = topologyPoint(event);
  canvas.style.setProperty("--cursor-x", `${point.x}px`);
  canvas.style.setProperty("--cursor-y", `${point.y}px`);
  const now = performance.now();
  if (now - topologyLastParticleAt < 28) return;
  topologyLastParticleAt = now;
  const layer = topologyParticlesLayer || canvas.querySelector(".topology-particles");
  if (!layer) return;
  const particle = document.createElement("span");
  particle.className = "topology-cursor-particle";
  particle.style.left = `${point.x}px`;
  particle.style.top = `${point.y}px`;
  particle.style.setProperty("--drift-x", `${(Math.random() - 0.5) * 42}px`);
  particle.style.setProperty("--drift-y", `${(Math.random() - 0.5) * 42}px`);
  layer.appendChild(particle);
  const particles = layer.querySelectorAll(".topology-cursor-particle");
  if (particles.length > 34) particles[0].remove();
  window.setTimeout(() => particle.remove(), 820);
}

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

$("router-select").addEventListener("change", async (event) => {
  localStorage.setItem("phala-router-admin-selected", event.target.value);
  selectedId = "";
  applyRouterDefaults();
  await refresh();
});

$("theme-select").addEventListener("change", (event) => {
  applyTheme(event.target.value);
});

$("refresh-btn").addEventListener("click", refresh);
$("save-btn").addEventListener("click", saveForm);
$("load-btn").addEventListener("click", loadSelected);
$("raw-btn").addEventListener("click", showRawConfig);
$("save-raw-btn").addEventListener("click", saveRaw);
$("close-editor-btn").addEventListener("click", () => setEditorOpen(false));
$("topology").addEventListener("mousemove", updateTopologyCursor);

$("app-main").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const container = button.closest("[data-node]");
  if (!container) return;
  const id = container.dataset.node;
  const node = nodeById(id);
  selectedId = id;
  try {
    if (button.dataset.action === "load") {
      loadNode(node);
      if (document.body.dataset.theme === "mesh-topology") setEditorOpen(true);
    }
    if (button.dataset.action === "toggle") await setEnabled(id, !(node && node.enabled));
    if (button.dataset.action === "delete") await deleteNode(id);
  } catch (err) {
    log(err.message, "err");
  }
});

applyTheme(preferredTheme());

loadRouters()
  .then(refresh)
  .catch((err) => {
    setStatus("load failed");
    log(err.message, "err");
  });

setInterval(refresh, 2000);
