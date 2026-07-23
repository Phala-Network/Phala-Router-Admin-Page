"use strict";

let routers = [];
let selectedId = "";
let latestSnapshot = null;
let refreshInFlight = false;
let topologyGraph = null;
let topologyGraphReady = false;
let topologyGraphContainer = null;
let topologyNetworkCanvas = null;
let topologyNetworkCtx = null;
let topologyNetworkFrame = 0;
let topologyNetworkLastSize = "";
let topologyNetworkPoints = [];
let topologyNetworkRipples = [];
let topologyNetworkPointer = { x: -10000, y: -10000, active: false };
let topologyNetworkLastScatter = { x: -10000, y: -10000, at: 0 };
let topologyParticlesLayer = null;
let topologyResizeObserver = null;
let topologyNodePositions = new Map();
let topologyPinnedNodes = new Set();
let topologyGraphSignature = "";
let topologyLastParticleAt = 0;

const $ = (id) => document.getElementById(id);
const THEMES = new Set(["phala-terminal", "vast-console", "clean-ops", "signal-board", "mesh-topology"]);
const TOPOLOGY_ZOOM_PADDING = 135;
const TOPOLOGY_UPSTREAM_MIN_DISTANCE = 255;
const TOPOLOGY_NETWORK_MIN_POINTS = 42;
const TOPOLOGY_NETWORK_MAX_POINTS = 58;
const TOPOLOGY_NETWORK_PATH_LINK_DISTANCE = 38;
const TOPOLOGY_NETWORK_MOUSE_DISTANCE = 69;
const TOPOLOGY_NETWORK_SCATTER_DISTANCE = 30;
const TOPOLOGY_NETWORK_SCATTER_COOLDOWN_MS = 180;
const TOPOLOGY_NETWORK_SETTLE_MS = 9200;

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
    if (next === "mesh-topology") {
      topologyGraph.resumeAnimation();
      startTopologyNetworkAnimation();
    } else {
      topologyGraph.pauseAnimation();
      stopTopologyNetworkAnimation();
    }
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
    graphNodes.forEach((node, index) => {
      if (node.type !== "upstream") return;
      const x = Number.isFinite(node.x) ? node.x : 0;
      const y = Number.isFinite(node.y) ? node.y : 0;
      const rawDistance = Math.hypot(x, y);
      const distance = Math.max(0.001, rawDistance);
      if (distance >= minRadius) return;
      const fallbackAngle = -Math.PI / 5 + index * 0.73;
      const dirX = rawDistance < 1 ? Math.cos(fallbackAngle) : x / distance;
      const dirY = rawDistance < 1 ? Math.sin(fallbackAngle) : y / distance;
      const push = (minRadius - distance) * alpha * 1.2;
      node.vx = (node.vx || 0) + dirX * push;
      node.vy = (node.vy || 0) + dirY * push;
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
  const angle = count === 1 ? -Math.PI / 5 : -Math.PI / 2 + (index / count) * Math.PI * 2;
  const radius = count === 1 ? 310 : count <= 4 ? 260 : 305;
  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius
  };
}

function usableSavedTopologyPosition(saved) {
  if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return false;
  return Math.hypot(saved.x, saved.y) >= TOPOLOGY_UPSTREAM_MIN_DISTANCE * 0.72;
}

function topologyPositionTooCloseToCore(node) {
  if (!node || !Number.isFinite(node.x) || !Number.isFinite(node.y)) return true;
  return Math.hypot(node.x, node.y) < TOPOLOGY_UPSTREAM_MIN_DISTANCE * 0.72;
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
    const useSaved = usableSavedTopologyPosition(saved);
    const pinned = topologyPinnedNodes.has(node.name);
    const singleUpstream = upstreams.length === 1;
    const metrics = topologyNodeMetrics(node);
    const graphNode = {
      id: node.name,
      type: "upstream",
      label: node.name,
      enabled: node.enabled,
      raw: node,
      metrics,
      x: useSaved ? saved.x : initial.x,
      y: useSaved ? saved.y : initial.y,
      fx: pinned && useSaved ? saved.fx ?? saved.x : singleUpstream ? initial.x : undefined,
      fy: pinned && useSaved ? saved.fy ?? saved.y : singleUpstream ? initial.y : undefined
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
    if (topologyPositionTooCloseToCore(currentNode)) {
      currentNode.x = nextNode.x;
      currentNode.y = nextNode.y;
      currentNode.vx = 0;
      currentNode.vy = 0;
    }
    if (!Number.isFinite(currentNode.x)) currentNode.x = nextNode.x;
    if (!Number.isFinite(currentNode.y)) currentNode.y = nextNode.y;
    if (Number.isFinite(nextNode.fx) && Number.isFinite(nextNode.fy)) {
      currentNode.fx = nextNode.fx;
      currentNode.fy = nextNode.fy;
    } else if (!topologyPinnedNodes.has(currentNode.id)) {
      currentNode.fx = undefined;
      currentNode.fy = undefined;
    }
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

function topologyNetworkPointCount(width, height) {
  const raw = Math.round((width * height) / 28000);
  return Math.max(TOPOLOGY_NETWORK_MIN_POINTS, Math.min(TOPOLOGY_NETWORK_MAX_POINTS, raw));
}

function topologyNetworkAnchor(width, height) {
  const fallback = { x: width / 2, y: height / 2 };
  const raw = topologyNetworkPointer.active ? topologyNetworkPointer : fallback;
  return {
    x: Math.max(96, Math.min(width - 96, raw.x)),
    y: Math.max(96, Math.min(height - 96, raw.y)),
    active: topologyNetworkPointer.active
  };
}

function topologyPShapeTargets(width, height, count) {
  const anchor = topologyNetworkAnchor(width, height);
  const pHeight = Math.min(height * 0.135, width * 0.075, 113);
  const stemX = anchor.x - pHeight * 0.26;
  const topY = anchor.y - pHeight * 0.47;
  const bottomY = anchor.y + pHeight * 0.47;
  const midY = topY + pHeight * 0.43;
  const rightX = stemX + pHeight * 0.34;
  const curveBulge = pHeight * 0.18;
  const stemCount = Math.max(20, Math.round(count * 0.34));
  const topCount = Math.max(10, Math.round(count * 0.17));
  const curveCount = Math.max(16, Math.round(count * 0.28));
  const midCount = Math.max(10, count - stemCount - topCount - curveCount);
  const targets = [];

  for (let i = 0; i < stemCount; i += 1) {
    const t = i / Math.max(1, stemCount - 1);
    targets.push({
      x: stemX,
      y: topY + (bottomY - topY) * t,
      section: "stem",
      order: i,
      anchorActive: anchor.active,
      stemCount,
      topCount,
      curveCount,
      midCount
    });
  }

  for (let i = 0; i < topCount; i += 1) {
    const t = i / Math.max(1, topCount - 1);
    targets.push({
      x: stemX + (rightX - stemX) * t,
      y: topY,
      section: "top",
      order: i,
      anchorActive: anchor.active,
      stemCount,
      topCount,
      curveCount,
      midCount
    });
  }

  for (let i = 0; i < curveCount; i += 1) {
    const t = i / Math.max(1, curveCount - 1);
    targets.push({
      x: rightX + Math.sin(t * Math.PI) * curveBulge,
      y: topY + (midY - topY) * t,
      section: "curve",
      order: i,
      anchorActive: anchor.active,
      stemCount,
      topCount,
      curveCount,
      midCount
    });
  }

  for (let i = 0; i < midCount; i += 1) {
    const t = i / Math.max(1, midCount - 1);
    targets.push({
      x: rightX + (stemX - rightX) * t,
      y: midY,
      section: "mid",
      order: i,
      anchorActive: anchor.active,
      stemCount,
      topCount,
      curveCount,
      midCount
    });
  }

  return targets;
}

function resetTopologyNetworkPoints(width, height) {
  const count = topologyNetworkPointCount(width, height);
  const targets = topologyPShapeTargets(width, height, count);
  const now = performance.now();
  topologyNetworkPoints = targets.map((target, index) => {
    return {
      x: width * (0.12 + Math.random() * 0.76),
      y: height * (0.16 + Math.random() * 0.68),
      targetX: target.x,
      targetY: target.y,
      section: target.section,
      order: target.order,
      anchorActive: target.anchorActive,
      stemCount: target.stemCount,
      topCount: target.topCount,
      curveCount: target.curveCount,
      midCount: target.midCount,
      vx: (Math.random() - 0.5) * 0.42,
      vy: (Math.random() - 0.5) * 0.42,
      size: 1.0 + Math.random() * 1.4,
      phase: Math.random() * Math.PI * 2,
      startedAt: now + index * 26
    };
  });
}

function retargetTopologyNetworkPoints(width, height) {
  const targets = topologyPShapeTargets(width, height, topologyNetworkPoints.length);
  topologyNetworkPoints.forEach((point, index) => {
    const target = targets[index];
    point.targetX = target.x;
    point.targetY = target.y;
    point.section = target.section;
    point.order = target.order;
    point.anchorActive = target.anchorActive;
    point.stemCount = target.stemCount;
    point.topCount = target.topCount;
    point.curveCount = target.curveCount;
    point.midCount = target.midCount;
  });
}

function scatterTopologyNetworkPoints(anchor) {
  if (!topologyNetworkPoints.length) return;
  const now = performance.now();
  topologyNetworkPoints.forEach((point, index) => {
    const dx = point.x - anchor.x;
    const dy = point.y - anchor.y;
    const distance = Math.hypot(dx, dy);
    const angle = distance > 1 ? Math.atan2(dy, dx) : Math.random() * Math.PI * 2;
    const swirl = (Math.random() - 0.5) * 1.4;
    const scatterAngle = angle + swirl;
    const burst = 0.9 + Math.random() * 1.6;
    const offset = 8 + Math.random() * 22;
    point.x += Math.cos(scatterAngle) * offset + (Math.random() - 0.5) * 10;
    point.y += Math.sin(scatterAngle) * offset + (Math.random() - 0.5) * 10;
    point.vx += Math.cos(scatterAngle) * burst + (Math.random() - 0.5) * 0.7;
    point.vy += Math.sin(scatterAngle) * burst + (Math.random() - 0.5) * 0.7;
    point.startedAt = now + index * 42;
    point.scatterUntil = now + 420;
  });
}

function maybeScatterTopologyNetwork(point) {
  const now = performance.now();
  const moved = Math.hypot(point.x - topologyNetworkLastScatter.x, point.y - topologyNetworkLastScatter.y);
  const enoughTime = now - topologyNetworkLastScatter.at > TOPOLOGY_NETWORK_SCATTER_COOLDOWN_MS;
  if (!topologyNetworkLastScatter.at || (moved >= TOPOLOGY_NETWORK_SCATTER_DISTANCE && enoughTime)) {
    topologyNetworkLastScatter = { x: point.x, y: point.y, at: now };
    scatterTopologyNetworkPoints(point);
  }
}

function syncTopologyNetworkCanvas() {
  if (!topologyNetworkCanvas) return null;
  const host = $("topology");
  const width = Math.max(320, Math.round(host.clientWidth || 0));
  const height = Math.max(420, Math.round(host.clientHeight || 0));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (topologyNetworkCanvas.width !== pixelWidth || topologyNetworkCanvas.height !== pixelHeight) {
    topologyNetworkCanvas.width = pixelWidth;
    topologyNetworkCanvas.height = pixelHeight;
    topologyNetworkCanvas.style.width = `${width}px`;
    topologyNetworkCanvas.style.height = `${height}px`;
    topologyNetworkCtx = topologyNetworkCanvas.getContext("2d");
    topologyNetworkCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  const nextSize = `${width}x${height}`;
  if (topologyNetworkLastSize !== nextSize || topologyNetworkPoints.length === 0) {
    const onlyResize = topologyNetworkLastSize && topologyNetworkPoints.length > 0;
    topologyNetworkLastSize = nextSize;
    if (onlyResize) retargetTopologyNetworkPoints(width, height);
    else resetTopologyNetworkPoints(width, height);
  }
  return { width, height };
}

function updateTopologyNetworkPoint(point, width, height) {
  const now = performance.now();
  const age = Math.max(0, now - (point.startedAt || now));
  const settle = Math.min(1, age / TOPOLOGY_NETWORK_SETTLE_MS);
  const breathe = Math.sin(now / 1200 + point.phase) * 1.15;
  const targetX = point.targetX + breathe * 0.45;
  const targetY = point.targetY + breathe;
  const dxTarget = targetX - point.x;
  const dyTarget = targetY - point.y;
  const spring = 0.00065 + settle * 0.0048;
  point.vx += dxTarget * spring;
  point.vy += dyTarget * spring;

  if (topologyNetworkPointer.active) {
    const dx = topologyNetworkPointer.x - point.x;
    const dy = topologyNetworkPointer.y - point.y;
    const distance = Math.max(1, Math.hypot(dx, dy));
    if (distance < TOPOLOGY_NETWORK_MOUSE_DISTANCE) {
      const wake = (1 - distance / TOPOLOGY_NETWORK_MOUSE_DISTANCE) * 0.008;
      point.vx += (-dy / distance) * wake;
      point.vy += (dx / distance) * wake;
    }
  }
  const speed = Math.hypot(point.vx, point.vy);
  const maxSpeed = now < (point.scatterUntil || 0) ? 2.2 : 0.16 + settle * 0.52;
  if (speed > maxSpeed) {
    point.vx = (point.vx / speed) * maxSpeed;
    point.vy = (point.vy / speed) * maxSpeed;
  }
  point.x += point.vx;
  point.y += point.vy;
  point.vx *= 0.94;
  point.vy *= 0.94;
  if (point.x < 18 || point.x > width - 18) {
    point.vx *= -1;
    point.x = Math.max(18, Math.min(width - 18, point.x));
  }
  if (point.y < 18 || point.y > height - 18) {
    point.vy *= -1;
    point.y = Math.max(18, Math.min(height - 18, point.y));
  }
}

function drawTopologyNetworkLine(ctx, a, b, maxDistance, baseAlpha, color) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const distance = Math.hypot(dx, dy);
  if (distance > maxDistance) return;
  const alpha = (1 - distance / maxDistance) * baseAlpha;
  ctx.strokeStyle = colorWithAlpha(color, alpha);
  ctx.lineWidth = Math.max(0.45, alpha * 7);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function topologyNetworkSettleRatio(point) {
  const age = Math.max(0, performance.now() - (point.startedAt || 0));
  return Math.min(1, age / TOPOLOGY_NETWORK_SETTLE_MS);
}

function drawTopologyPShapePath(ctx, points, primary, blue) {
  if (points.length < 4) return;
  const bySection = points.reduce((out, point) => {
    if (!out[point.section]) out[point.section] = [];
    out[point.section].push(point);
    return out;
  }, {});
  ["stem", "top", "curve", "mid"].forEach((section) => {
    const sectionPoints = bySection[section] || [];
    for (let i = 0; i < sectionPoints.length - 1; i += 1) {
      const color = section === "curve" ? blue : primary;
      const readiness = Math.min(topologyNetworkSettleRatio(sectionPoints[i]), topologyNetworkSettleRatio(sectionPoints[i + 1]));
      const alpha = (section === "curve" ? 0.22 : 0.24) * readiness;
      drawTopologyNetworkLine(ctx, sectionPoints[i], sectionPoints[i + 1], TOPOLOGY_NETWORK_PATH_LINK_DISTANCE, alpha, color);
    }
  });

  const stem = bySection.stem || [];
  const top = bySection.top || [];
  const curve = bySection.curve || [];
  const mid = bySection.mid || [];
  const stemCount = stem.length;
  const stemMid = Math.min(stemCount - 1, Math.max(0, Math.round((stemCount - 1) * 0.47)));
  if (stem[0] && top[0]) drawTopologyNetworkLine(ctx, stem[0], top[0], TOPOLOGY_NETWORK_PATH_LINK_DISTANCE, 0.24 * Math.min(topologyNetworkSettleRatio(stem[0]), topologyNetworkSettleRatio(top[0])), primary);
  if (top.at(-1) && curve[0]) drawTopologyNetworkLine(ctx, top.at(-1), curve[0], TOPOLOGY_NETWORK_PATH_LINK_DISTANCE, 0.22 * Math.min(topologyNetworkSettleRatio(top.at(-1)), topologyNetworkSettleRatio(curve[0])), blue);
  if (curve.at(-1) && mid[0]) drawTopologyNetworkLine(ctx, curve.at(-1), mid[0], TOPOLOGY_NETWORK_PATH_LINK_DISTANCE, 0.22 * Math.min(topologyNetworkSettleRatio(curve.at(-1)), topologyNetworkSettleRatio(mid[0])), blue);
  if (mid.at(-1) && stem[stemMid]) drawTopologyNetworkLine(ctx, mid.at(-1), stem[stemMid], TOPOLOGY_NETWORK_PATH_LINK_DISTANCE, 0.24 * Math.min(topologyNetworkSettleRatio(mid.at(-1)), topologyNetworkSettleRatio(stem[stemMid])), primary);
}

function drawTopologyNetworkFrame() {
  topologyNetworkFrame = 0;
  if (document.body.dataset.theme !== "mesh-topology") return;
  const size = syncTopologyNetworkCanvas();
  if (!size || !topologyNetworkCtx) return;
  const { width, height } = size;
  const ctx = topologyNetworkCtx;
  const primary = cssValue("--primary");
  const blue = cssValue("--blue");
  ctx.clearRect(0, 0, width, height);

  retargetTopologyNetworkPoints(width, height);
  topologyNetworkPoints.forEach((point) => updateTopologyNetworkPoint(point, width, height));

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  drawTopologyPShapePath(ctx, topologyNetworkPoints, primary, blue);
  for (let i = 0; i < topologyNetworkPoints.length; i += 1) {
    const a = topologyNetworkPoints[i];
    if (topologyNetworkPointer.active) {
      drawTopologyNetworkLine(ctx, a, topologyNetworkPointer, TOPOLOGY_NETWORK_MOUSE_DISTANCE, 0.12, primary);
    }
  }

  topologyNetworkPoints.forEach((point) => {
    ctx.fillStyle = colorWithAlpha(point.section === "curve" ? blue : primary, 0.48);
    ctx.beginPath();
    ctx.arc(point.x, point.y, point.size, 0, Math.PI * 2);
    ctx.fill();
  });

  if (topologyNetworkPointer.active) {
    const glow = ctx.createRadialGradient(topologyNetworkPointer.x, topologyNetworkPointer.y, 0, topologyNetworkPointer.x, topologyNetworkPointer.y, 24);
    glow.addColorStop(0, colorWithAlpha(primary, 0.34));
    glow.addColorStop(1, colorWithAlpha(primary, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(topologyNetworkPointer.x, topologyNetworkPointer.y, 24, 0, Math.PI * 2);
    ctx.fill();
  }

  const now = performance.now();
  topologyNetworkRipples = topologyNetworkRipples.filter((ripple) => now - ripple.startedAt < 720);
  topologyNetworkRipples.forEach((ripple) => {
    const progress = (now - ripple.startedAt) / 720;
    ctx.strokeStyle = colorWithAlpha(primary, (1 - progress) * 0.32);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(ripple.x, ripple.y, 12 + progress * 54, 0, Math.PI * 2);
    ctx.stroke();
  });
  ctx.restore();

  topologyNetworkFrame = window.requestAnimationFrame(drawTopologyNetworkFrame);
}

function startTopologyNetworkAnimation() {
  if (topologyNetworkFrame || !topologyNetworkCanvas) return;
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  topologyNetworkFrame = window.requestAnimationFrame(drawTopologyNetworkFrame);
}

function stopTopologyNetworkAnimation() {
  if (!topologyNetworkFrame) return;
  window.cancelAnimationFrame(topologyNetworkFrame);
  topologyNetworkFrame = 0;
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
  const canvas = $("topology");
  syncTopologyNetworkCanvas();
  if (!topologyGraph || !topologyGraphContainer) return;
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
    <canvas class="topology-network-canvas" aria-hidden="true"></canvas>
    <div class="topology-graph"></div>
    <div class="topology-cursor-orb"></div>
    <div class="topology-particles"></div>
    <div class="topology-hint mono">drag canvas / scroll zoom / drag nodes / click node to edit</div>
  `;
  topologyNetworkCanvas = canvas.querySelector(".topology-network-canvas");
  topologyGraphContainer = canvas.querySelector(".topology-graph");
  topologyParticlesLayer = canvas.querySelector(".topology-particles");
  topologyGraph = ForceGraph()(topologyGraphContainer)
    .backgroundColor("rgba(0,0,0,0)")
    .nodeId("id")
    .nodeVal((node) => node.type === "core" ? 1600 : 530)
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
  startTopologyNetworkAnimation();
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
  topologyNetworkPointer = { x: point.x, y: point.y, active: true };
  maybeScatterTopologyNetwork(point);
  startTopologyNetworkAnimation();
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

function leaveTopologyCursor() {
  topologyNetworkPointer.active = false;
  topologyNetworkLastScatter = { x: -10000, y: -10000, at: 0 };
  const canvas = $("topology");
  canvas.style.setProperty("--cursor-x", "-100px");
  canvas.style.setProperty("--cursor-y", "-100px");
}

function rippleTopologyCursor(event) {
  if (document.body.dataset.theme !== "mesh-topology") return;
  const point = topologyPoint(event);
  topologyNetworkRipples.push({ x: point.x, y: point.y, startedAt: performance.now() });
  if (topologyNetworkRipples.length > 8) topologyNetworkRipples.shift();
  startTopologyNetworkAnimation();
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
$("topology").addEventListener("mouseleave", leaveTopologyCursor);
$("topology").addEventListener("click", rippleTopologyCursor);

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
