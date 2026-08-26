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
let topologyBackgroundPoints = [];
let topologyResizeObserver = null;
let topologyNodePositions = new Map();
let topologyPinnedNodes = new Set();
let topologyGraphSignature = "";
let latestPigPolicy = null;
let latestPigPolicyNode = "";
let pigPolicyTPSCache = new Map();

const $ = (id) => document.getElementById(id);
const THEMES = new Set(["phala-terminal", "vast-console", "clean-ops", "signal-board", "mesh-topology"]);
const TOPOLOGY_ZOOM_PADDING = 135;
const TOPOLOGY_UPSTREAM_MIN_DISTANCE = 255;
const TOPOLOGY_LAYOUT_SINGLE_X = 330;
const TOPOLOGY_LAYOUT_PAIR_X = 330;
const TOPOLOGY_LAYOUT_SIDE_BASE_X = 445;
const TOPOLOGY_LAYOUT_SIDE_X_STEP = 72;
const TOPOLOGY_LAYOUT_SIDE_MIN_Y_STEP = 172;
const TOPOLOGY_LAYOUT_SIDE_MAX_Y_STEP = 205;
const TOPOLOGY_NETWORK_MIN_POINTS = 72;
const TOPOLOGY_NETWORK_MAX_POINTS = 118;
const TOPOLOGY_NETWORK_POINT_LINK_DISTANCE = 126;
const TOPOLOGY_NETWORK_CORE_CAPTURE_DISTANCE = 290;
const TOPOLOGY_NETWORK_CORE_ORBIT_RADIUS = 188;
const TOPOLOGY_NETWORK_UPSTREAM_CAPTURE_DISTANCE = 152;
const TOPOLOGY_NETWORK_UPSTREAM_ORBIT_RADIUS = 94;
const TOPOLOGY_NETWORK_ORBIT_FORCE = 0.033;
const TOPOLOGY_NETWORK_RADIAL_FORCE = 0.00165;
const TOPOLOGY_NETWORK_MAX_SPEED = 1.18;
const TOPOLOGY_NETWORK_EDGE_PADDING = 28;
const TOPOLOGY_NETWORK_MIN_ORBIT_RADIUS = 30;
const TOPOLOGY_NETWORK_MIN_ORBIT_SPEED = 0.58;
const TOPOLOGY_NETWORK_MAX_ORBIT_SPEED = 1.52;
const TOPOLOGY_BACKGROUND_MIN_POINTS = 34;
const TOPOLOGY_BACKGROUND_MAX_POINTS = 68;
const TOPOLOGY_BACKGROUND_POINT_LINK_DISTANCE = 164;
const TOPOLOGY_BACKGROUND_MIN_SPEED = 0.045;
const TOPOLOGY_BACKGROUND_MAX_SPEED = 0.46;
const TOPOLOGY_ROUTE_PARTICLE_SPEED = 0.00032;

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
  if (options.unavailable) return "pressure";
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
  const unavailable = Boolean(options.unavailable);
  const rawPct = pct(value, limit);
  const explicitPressure = options.tone === "pressure" || options.tone === "metrics_error";
  const p = hasPressure || explicitPressure
    ? (rawPct > 0 ? Math.max(8, rawPct) : 100)
    : (unavailable ? Math.max(8, rawPct) : rawPct);
  const klass = explicitPressure
    ? "pressure"
    : (options.tone === "metrics_stale" ? "yellow" : (options.tone === "healthy" ? "green" : metricLevel(value, limit, options)));
  const chips = [];
  if (options.chip) chips.push(`<span class="meter-chip ${escapeAttr(options.chipTone || "neutral")}">${escapeHTML(options.chip)}</span>`);
  if (unavailable) chips.push(`<span class="meter-chip pressure">not selectable</span>`);
  if (hasPressure) chips.push(`<span class="meter-chip pressure">waiting ${fmt(waiting)}</span>`);
  return `
    <div class="metric-head">
      <span class="mono metric-value">${fmt(value)}${limit !== null && limit !== undefined ? " / " + fmt(limit) : ""}</span>
      ${chips.join("")}
    </div>
    <div class="bar ${klass}" style="--w:${p}%"><span></span></div>
    ${subline ? `<div class="subline mono metric-subline">${subline}</div>` : ""}
  `;
}

function capacityFor(node) {
  const capacity = node.runtime?.capacity;
  if (capacity && capacity.protocol) return capacity;
  const pig = node.runtime?.pig || {};
  const route = node.route || {};
  return {
    protocol: "legacy",
    request_aware: false,
    state: node.enabled ? "legacy" : "disabled",
    label: node.enabled ? "legacy capacity" : "disabled",
    tone: node.enabled ? "healthy" : "disabled",
    reason: node.enabled ? "count-based global limit" : "not in routing pool",
    selectable: Boolean(node.enabled),
    running: pig.running ?? route.running ?? 0,
    effective_running: route.effective_running ?? route.running ?? 0,
    display_limit: pig.global_limit ?? null,
    pending_reservations: route.pending_reservations ?? 0,
    dispatch_debt: route.unreconciled_dispatches ?? 0,
    upstream_attempts: route.upstream_attempts ?? 0,
    upstream_429: route.upstream_429 ?? 0
  };
}

function capacityRunText(capacity, running) {
  if (capacity?.protocol === "request_aware_open") return `run ${fmt(running)} • request-aware`;
  return `run ${fmt(running)}${capacity?.display_limit !== null && capacity?.display_limit !== undefined ? " / " + fmt(capacity.display_limit) : ""}`;
}

function capacitySubline(capacity) {
  const fields = [capacity?.reason || capacity?.protocol || "capacity unknown"];
  if (capacity?.inspect_capacity !== null && capacity?.inspect_capacity !== undefined) fields.push(`inspect ${fmt(capacity.inspect_capacity)}`);
  if (Number(capacity?.pending_reservations || 0) > 0) fields.push(`pending ${fmt(capacity.pending_reservations)}`);
  if (Number(capacity?.dispatch_debt || 0) > 0) fields.push(`debt ${fmt(capacity.dispatch_debt)}`);
  return fields.join(" • ");
}

function capacityMeterTone(capacity) {
  if (capacity?.protocol === "legacy" && capacity?.tone === "healthy") return undefined;
  return capacity?.tone;
}

function selectionCell(route) {
  return `
    <div class="mono">cache ${fmt(route?.selected_by_cache || 0)}</div>
    <div class="mono">load picks ${fmt(route?.selected_by_load || 0)}</div>
    <div class="mono">order ${fmt(route?.selected_by_order || 0)}</div>
    <div class="mono">attempt ${fmt(route?.upstream_attempts || 0)} • 429 ${fmt(route?.upstream_429 || 0)}</div>
  `;
}

function renderSummary(summary) {
  const items = [
    { label: "nodes", value: summary.nodes, tone: "neutral", hint: "configured" },
    { label: "enabled", value: summary.enabled_nodes, tone: "green" },
    { label: "selectable", value: summary.selectable_nodes, tone: Number(summary.selectable_nodes || 0) < Number(summary.enabled_nodes || 0) ? "pressure" : "green" },
    { label: "request-aware", value: summary.request_aware_nodes, tone: Number(summary.request_aware_nodes || 0) > 0 ? "blue" : "neutral" },
    { label: "protected", value: summary.protected_nodes, tone: Number(summary.protected_nodes || 0) > 0 ? "pressure" : "neutral" },
    { label: "protocol invalid", value: summary.invalid_protocol_nodes, tone: Number(summary.invalid_protocol_nodes || 0) > 0 ? "pressure" : "neutral" },
    { label: "router run", value: summary.router_running, tone: Number(summary.router_running || 0) > 0 ? "blue" : "neutral" },
    { label: "PIG run", value: summary.pig_running, tone: Number(summary.waiting || 0) > 0 ? "pressure" : "green" },
    { label: "backend run", value: summary.backend_running, tone: Number(summary.waiting || 0) > 0 ? "pressure" : "green" },
    { label: "waiting", value: summary.waiting, tone: Number(summary.waiting || 0) > 0 ? "pressure" : "neutral" },
    { label: "stale", value: summary.stale_nodes, tone: Number(summary.stale_nodes || 0) > 0 ? "yellow" : "neutral" },
    { label: "cache", value: summary.cache_selected, tone: Number(summary.cache_selected || 0) > 0 ? "blue" : "neutral" },
    { label: "load picks", value: summary.load_selected, tone: Number(summary.load_selected || 0) > 0 ? "blue" : "neutral" },
    { label: "upstream 429", value: summary.upstream_429, tone: Number(summary.upstream_429 || 0) > 0 ? "blue" : "neutral" },
    { label: "dispatch debt", value: summary.dispatch_debt, tone: Number(summary.dispatch_debt || 0) > 0 ? "yellow" : "neutral" }
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
  const capacity = capacityFor(node);
  const routerLimit = capacity.display_limit;
  const pigWaiting = pig.waiting ?? backend.waiting ?? 0;
  const backendWaiting = backend.waiting ?? pig.waiting ?? 0;
  const publicModel = Object.keys(node.models || {})[0] || "";
  const upstreamModel = publicModel ? node.models[publicModel] : "";
  const enabledClass = node.enabled ? "enabled" : "disabled";
  const healthStatus = capacity.tone || node.health?.status || "unknown";
  const healthLabel = capacity.label || node.health?.status || "unknown";
  const healthReason = [capacity.reason, node.health?.reason].filter(Boolean).join("; ");
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
      <td>${node.enabled ? meter(pig.running, capacity.display_limit, capacitySubline(capacity), { waiting: pigWaiting, tone: capacityMeterTone(capacity), chip: capacity.label, chipTone: capacity.tone }) : meter(null, null)}</td>
      <td>${node.enabled ? meter(backend.running, capacity.display_limit, `waiting ${fmt(backend.waiting)} kv ${fmt(backend.kv_usage)}`, { waiting: backendWaiting, tone: capacity.state === "protected" ? "pressure" : undefined }) : meter(null, null, "waiting - kv -")}</td>
      <td>${meter(route.running || 0, routerLimit, `effective ${fmt(capacity.effective_running)} • processed ${fmt(route.processed || 0)} • debt ${fmt(capacity.dispatch_debt)}`, { tone: capacityMeterTone(capacity) })}</td>
      <td>${selectionCell(route)}</td>
      <td><span class="pill ${escapeAttr(healthStatus)}">${escapeHTML(healthLabel)}</span>${healthReason ? `<div class="subline">${escapeHTML(healthReason)}</div>` : ""}</td>
      <td>
        <div class="row-actions">
          <div class="node-action-buttons">
            <button data-action="load">load</button>
            <button data-action="policy">policy</button>
            <button class="danger" data-action="delete">delete</button>
          </div>
        </div>
      </td>
    </tr>
  `;
}

function renderNodeCard(node) {
  const route = node.route || {};
  const pig = node.runtime?.pig || {};
  const backend = node.runtime?.backend || {};
  const capacity = capacityFor(node);
  const routerLimit = capacity.display_limit;
  const pigWaiting = pig.waiting ?? backend.waiting ?? 0;
  const backendWaiting = backend.waiting ?? pig.waiting ?? 0;
  const publicModel = Object.keys(node.models || {})[0] || "";
  const upstreamModel = publicModel ? node.models[publicModel] : "";
  const enabledClass = node.enabled ? "enabled" : "disabled";
  const healthStatus = capacity.tone || node.health?.status || "unknown";
  const healthLabel = capacity.label || node.health?.status || "unknown";
  const compactStatus = compactCapacityLabel(capacity, healthLabel);
  const healthReason = [capacity.reason, node.health?.reason].filter(Boolean).join("; ");
  return `
    <article class="node-card ${enabledClass} ${escapeAttr(healthStatus)}" data-node="${escapeAttr(node.name)}">
      <div class="node-card-top">
        <div class="node-card-heading">
          <div class="node-title">${escapeHTML(node.name)}</div>
          <div class="subline mono">${escapeHTML(publicModel)}${upstreamModel ? " -> " + escapeHTML(upstreamModel) : ""}</div>
        </div>
        <div class="node-card-state">
          <span class="pill ${escapeAttr(healthStatus)}">${escapeHTML(compactStatus)}</span>
          <button class="switch ${enabledClass}" data-action="toggle">${node.enabled ? "enabled" : "disabled"}</button>
        </div>
      </div>
      <div class="node-card-endpoint">
        <div class="mono">${escapeHTML(node.base_url || "")}</div>
        <div>${escapeHTML(node.provider || "")}</div>
      </div>
      ${healthReason ? `<div class="health-note">${escapeHTML(healthReason)}</div>` : ""}
      <div class="node-card-metrics">
        <div class="card-meter">
          <div class="card-meter-title">PIG run</div>
          ${node.enabled ? meter(pig.running, capacity.display_limit, capacitySubline(capacity), { waiting: pigWaiting, tone: capacityMeterTone(capacity), chip: compactStatus, chipTone: capacity.tone }) : meter(null, null)}
        </div>
        <div class="card-meter">
          <div class="card-meter-title">Backend</div>
          ${node.enabled ? meter(backend.running, capacity.display_limit, `waiting ${fmt(backend.waiting)} kv ${fmt(backend.kv_usage)}`, { waiting: backendWaiting, tone: capacity.state === "protected" ? "pressure" : undefined }) : meter(null, null, "waiting - kv -")}
        </div>
        <div class="card-meter">
          <div class="card-meter-title">Router</div>
          ${meter(route.running || 0, routerLimit, `effective ${fmt(capacity.effective_running)} • processed ${fmt(route.processed || 0)} • debt ${fmt(capacity.dispatch_debt)}`, { tone: capacityMeterTone(capacity) })}
        </div>
      </div>
      <div class="node-card-footer">
        <div class="card-selection mono">
          <span>cache ${fmt(route.selected_by_cache || 0)}</span>
          <span>load picks ${fmt(route.selected_by_load || 0)}</span>
          <span>attempt ${fmt(route.upstream_attempts || 0)} • 429 ${fmt(route.upstream_429 || 0)}</span>
          <span>order ${fmt(route.selected_by_order || 0)}</span>
        </div>
      </div>
      <div class="row-actions node-card-actions">
        ${renderDirectTPSControl(node)}
        <div class="node-action-buttons">
          <button data-action="load">load</button>
          <button data-action="policy">policy</button>
          <button class="danger" data-action="delete">delete</button>
        </div>
      </div>
    </article>
  `;
}

function compactCapacityLabel(capacity, fallback) {
  const state = String(capacity?.state || "").trim();
  if (state === "open") return "open";
  if (state === "protected") return "protected";
  if (state === "legacy") return "legacy";
  if (state === "disabled") return "disabled";
  if (state === "metrics_error") return "metrics error";
  if (state === "metrics_stale") return "stale";
  return String(fallback || "unknown").replace(/^request-aware\s+/i, "");
}

function pigPolicyCacheKey(nodeID, routerID = currentRouterId()) {
  return `${routerID}::${nodeID}`;
}

function cachedPigTPSReference(nodeID) {
  const cached = pigPolicyTPSCache.get(pigPolicyCacheKey(nodeID));
  return Number.isFinite(cached) ? cached : null;
}

function rememberPigPolicy(nodeID, policy) {
  const tpsReference = Number(policy?.mutable?.tps_reference);
  if (nodeID && Number.isInteger(tpsReference)) {
    pigPolicyTPSCache.set(pigPolicyCacheKey(nodeID), tpsReference);
  }
}

function renderDirectTPSControl(node) {
  const value = cachedPigTPSReference(node.name);
  return `
    <div class="tps-control" data-policy-node="${escapeAttr(node.name)}">
      <span class="tps-label">TPS</span>
      <input class="tps-input" data-role="tps-reference" type="number" min="0" max="1000000" step="1" inputmode="numeric" placeholder="TPS" value="${value === null ? "" : escapeAttr(value)}" aria-label="PIG TPS reference for ${escapeAttr(node.name)}">
      <button class="tps-action" data-action="set-tps" type="button" aria-label="Set integer PIG TPS reference for ${escapeAttr(node.name)}">Set</button>
    </div>
  `;
}

function nodeTone(node) {
  const capacity = capacityFor(node);
  if (!node.enabled || capacity.tone === "disabled") return "disabled";
  if (capacity.tone === "pressure" || capacity.tone === "metrics_error") return "pressure";
  if (capacity.tone === "metrics_stale") return "yellow";
  if (capacity.protocol === "legacy") {
    const pig = node.runtime?.pig || {};
    const backend = node.runtime?.backend || {};
    const running = pig.running ?? backend.running ?? node.route?.running;
    const waiting = pig.waiting ?? backend.waiting ?? 0;
    return metricLevel(running, capacity.display_limit, { waiting });
  }
  return "green";
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
  const capacity = capacityFor(node);
  const running = Number(capacity.effective_running ?? pig.running ?? backend.running ?? route.running ?? 0);
  const limit = capacity.display_limit;
  const waiting = Number(pig.waiting ?? backend.waiting ?? 0);
  const publicModel = Object.keys(node.models || {})[0] || "";
  return {
    route,
    pig,
    backend,
    capacity,
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
    { label: "selectable", value: summary.selectable_nodes, tone: Number(summary.selectable_nodes || 0) < Number(summary.enabled_nodes || 0) ? "pressure" : "green" },
    { label: "request-aware", value: summary.request_aware_nodes, tone: Number(summary.request_aware_nodes || 0) > 0 ? "blue" : "neutral" },
    { label: "protected", value: summary.protected_nodes, tone: Number(summary.protected_nodes || 0) > 0 ? "pressure" : "neutral" },
    { label: "protocol invalid", value: summary.invalid_protocol_nodes, tone: Number(summary.invalid_protocol_nodes || 0) > 0 ? "pressure" : "neutral" },
    { label: "stale", value: summary.stale_nodes, tone: Number(summary.stale_nodes || 0) > 0 ? "yellow" : "neutral" },
    { label: "router", value: summary.router_running, tone: Number(summary.router_running || 0) > 0 ? "blue" : "neutral" },
    { label: "PIG", value: summary.pig_running, tone: Number(summary.waiting || 0) > 0 ? "pressure" : "green" },
    { label: "backend", value: summary.backend_running, tone: Number(summary.waiting || 0) > 0 ? "pressure" : "green" },
    { label: "waiting", value: summary.waiting, tone: Number(summary.waiting || 0) > 0 ? "pressure" : "neutral" },
    { label: "cache", value: summary.cache_selected, tone: "blue" },
    { label: "load picks", value: summary.load_selected, tone: "blue" },
    { label: "upstream 429", value: summary.upstream_429, tone: Number(summary.upstream_429 || 0) > 0 ? "blue" : "neutral" },
    { label: "dispatch debt", value: summary.dispatch_debt, tone: Number(summary.dispatch_debt || 0) > 0 ? "yellow" : "neutral" }
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

function coreStatRows(count) {
  if (count <= 3) return [count];
  if (count <= 6) return [3, count - 3];
  if (count <= 9) return [3, 3, count - 6];
  const rows = [];
  let remaining = count;
  while (remaining > 0) {
    const rowCount = Math.min(3, remaining);
    rows.push(rowCount);
    remaining -= rowCount;
  }
  return rows;
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

  const cellW = 54;
  const cellH = 24;
  const gap = 5;
  const rowSizes = coreStatRows(stats.length);
  const gridH = rowSizes.length * cellH + Math.max(0, rowSizes.length - 1) * gap;
  const startY = y - gridH / 2 + 16;
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
    : colorWithAlpha(color, 0.13);
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
    drawCenteredText(ctx, capacityRunText(metrics.capacity, metrics.running), x, y + 13, 118, "800 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", mutedStrong);
  }
  const route = metrics.route || {};
  const wait = Number(metrics.waiting || 0) > 0 ? ` wait ${fmt(metrics.waiting)}` : "";
  drawCenteredText(ctx, disabled ? "not in routing pool" : `cache ${fmt(route.selected_by_cache || 0)} load picks ${fmt(route.selected_by_load || 0)}${wait}`, x, y + 35, 118, "700 8px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", muted);
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
  if (link.direction === "upstream_to_core") return 0.85;
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

function topologyLayoutBiasForce() {
  let graphNodes = [];
  function force(alpha) {
    graphNodes.forEach((node) => {
      if (node.type !== "upstream" || topologyPinnedNodes.has(node.id)) return;
      if (!Number.isFinite(node.layoutX) || !Number.isFinite(node.layoutY)) return;
      const x = Number.isFinite(node.x) ? node.x : node.layoutX;
      const y = Number.isFinite(node.y) ? node.y : node.layoutY;
      node.vx = (node.vx || 0) + (node.layoutX - x) * alpha * 0.055;
      node.vy = (node.vy || 0) + (node.layoutY - y) * alpha * 0.25;
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

function topologySideFanPosition(side, localIndex, sideCount) {
  const sign = side === "left" ? -1 : 1;
  if (sideCount <= 1) return { x: sign * TOPOLOGY_LAYOUT_SIDE_BASE_X, y: 0 };
  const yStep = Math.max(
    TOPOLOGY_LAYOUT_SIDE_MIN_Y_STEP,
    TOPOLOGY_LAYOUT_SIDE_MAX_Y_STEP - Math.max(0, sideCount - 2) * 9
  );
  const center = (sideCount - 1) / 2;
  const offset = localIndex - center;
  const absOffset = Math.abs(offset);
  const x = sign * (TOPOLOGY_LAYOUT_SIDE_BASE_X + absOffset * TOPOLOGY_LAYOUT_SIDE_X_STEP);
  return {
    x,
    y: offset * yStep
  };
}

function initialTopologyPosition(index, total) {
  const count = Math.max(1, total);
  if (count === 1) return { x: TOPOLOGY_LAYOUT_SINGLE_X, y: 0 };
  if (count === 2) return { x: index === 0 ? -TOPOLOGY_LAYOUT_PAIR_X : TOPOLOGY_LAYOUT_PAIR_X, y: 0 };
  const leftCount = Math.floor(count / 2);
  const rightCount = count - leftCount;
  if (index < leftCount) return topologySideFanPosition("left", index, leftCount);
  return topologySideFanPosition("right", index - leftCount, rightCount);
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
      layoutX: initial.x,
      layoutY: initial.y,
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
      direction: "core_to_upstream",
      tone: metrics.tone,
      running: metrics.running,
      waiting: metrics.waiting
    });
    if (node.enabled && metrics.tone !== "disabled") {
      graphLinks.push({
        source: node.name,
        target: "__router__",
        kind: "route",
        direction: "upstream_to_core",
        tone: metrics.tone,
        running: metrics.running,
        waiting: metrics.waiting
      });
    }
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
    currentNode.layoutX = nextNode.layoutX;
    currentNode.layoutY = nextNode.layoutY;
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
    currentLink.direction = nextLink.direction;
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
  const raw = Math.round((width * height) / 10500);
  return Math.max(TOPOLOGY_NETWORK_MIN_POINTS, Math.min(TOPOLOGY_NETWORK_MAX_POINTS, raw));
}

function topologyBackgroundPointCount(width, height) {
  const raw = Math.round((width * height) / 18500);
  return Math.max(TOPOLOGY_BACKGROUND_MIN_POINTS, Math.min(TOPOLOGY_BACKGROUND_MAX_POINTS, raw));
}

function randomTopologyBackgroundSpeed() {
  const curve = Math.random() ** 1.35;
  return TOPOLOGY_BACKGROUND_MIN_SPEED + curve * (TOPOLOGY_BACKGROUND_MAX_SPEED - TOPOLOGY_BACKGROUND_MIN_SPEED);
}

function randomTopologyNetworkOrbitSpeed() {
  const curve = Math.random() ** 1.18;
  return TOPOLOGY_NETWORK_MIN_ORBIT_SPEED + curve * (TOPOLOGY_NETWORK_MAX_ORBIT_SPEED - TOPOLOGY_NETWORK_MIN_ORBIT_SPEED);
}

function resetTopologyNetworkPoints(width, height) {
  const count = topologyNetworkPointCount(width, height);
  topologyNetworkPoints = Array.from({ length: count }, () => {
    return {
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() * 2 - 1) * 0.58,
      vy: (Math.random() * 2 - 1) * 0.58,
      size: 0.8 + Math.random() * 0.9,
      orbitDir: Math.random() < 0.5 ? -1 : 1,
      orbitSpeed: randomTopologyNetworkOrbitSpeed()
    };
  });
}

function resetTopologyBackgroundPoints(width, height) {
  const count = topologyBackgroundPointCount(width, height);
  topologyBackgroundPoints = Array.from({ length: count }, () => {
    const angle = Math.random() * Math.PI * 2;
    const speed = randomTopologyBackgroundSpeed();
    return {
      x: Math.random() * width,
      y: Math.random() * height,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: 0.65 + Math.random() * 0.7
    };
  });
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
  const sizeChanged = topologyNetworkLastSize !== nextSize;
  if (sizeChanged || topologyNetworkPoints.length === 0) {
    topologyNetworkLastSize = nextSize;
    resetTopologyNetworkPoints(width, height);
  }
  if (sizeChanged || topologyBackgroundPoints.length === 0) resetTopologyBackgroundPoints(width, height);
  return { width, height };
}

function topologyNodeScreenPosition(node, width, height) {
  if (!node || !Number.isFinite(node.x) || !Number.isFinite(node.y)) return null;
  if (topologyGraph && typeof topologyGraph.graph2ScreenCoords === "function") {
    const pos = topologyGraph.graph2ScreenCoords(node.x, node.y);
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) return pos;
  }
  return { x: width / 2 + node.x, y: height / 2 + node.y };
}

function topologyGraphZoomScale() {
  if (!topologyGraph || typeof topologyGraph.zoom !== "function") return 1;
  const zoom = topologyGraph.zoom();
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

function boundedTopologySourceRadii(pos, width, height, orbitRadius, captureDistance) {
  const visibleOrbitLimit = Math.min(pos.x, width - pos.x, pos.y, height - pos.y) - TOPOLOGY_NETWORK_EDGE_PADDING;
  if (!Number.isFinite(visibleOrbitLimit) || visibleOrbitLimit < TOPOLOGY_NETWORK_MIN_ORBIT_RADIUS) return null;
  const boundedOrbitRadius = Math.min(orbitRadius, visibleOrbitLimit);
  const boundedCaptureDistance = Math.min(
    captureDistance,
    Math.max(boundedOrbitRadius + TOPOLOGY_NETWORK_EDGE_PADDING * 1.5, visibleOrbitLimit + TOPOLOGY_NETWORK_EDGE_PADDING)
  );
  return {
    orbitRadius: boundedOrbitRadius,
    captureDistance: Math.max(boundedCaptureDistance, boundedOrbitRadius + TOPOLOGY_NETWORK_EDGE_PADDING)
  };
}

function topologyNetworkSources(width, height) {
  if (!topologyGraph) return [];
  const graphData = topologyGraph.graphData();
  const zoomScale = topologyGraphZoomScale();
  return (graphData.nodes || [])
    .filter((node) => node.type === "core" || (node.enabled && node.metrics?.tone !== "disabled"))
    .map((node) => {
      const pos = topologyNodeScreenPosition(node, width, height);
      if (!pos) return null;
      const core = node.type === "core";
      const captureDistance = (core ? TOPOLOGY_NETWORK_CORE_CAPTURE_DISTANCE : TOPOLOGY_NETWORK_UPSTREAM_CAPTURE_DISTANCE) * zoomScale;
      const orbitRadius = (core ? TOPOLOGY_NETWORK_CORE_ORBIT_RADIUS : TOPOLOGY_NETWORK_UPSTREAM_ORBIT_RADIUS) * zoomScale;
      const radii = boundedTopologySourceRadii(pos, width, height, orbitRadius, captureDistance);
      if (!radii) return null;
      return {
        x: pos.x,
        y: pos.y,
        type: node.type,
        captureDistance: radii.captureDistance,
        orbitRadius: radii.orbitRadius,
        orbitForce: core ? TOPOLOGY_NETWORK_ORBIT_FORCE * 0.74 : TOPOLOGY_NETWORK_ORBIT_FORCE,
        radialForce: core ? TOPOLOGY_NETWORK_RADIAL_FORCE * 0.8 : TOPOLOGY_NETWORK_RADIAL_FORCE
      };
    })
    .filter((source) => source && source.x > -source.captureDistance && source.x < width + source.captureDistance && source.y > -source.captureDistance && source.y < height + source.captureDistance);
}

function nearestTopologyNetworkSource(point, sources) {
  let nearest = null;
  let nearestScore = Infinity;
  for (const source of sources) {
    const dx = point.x - source.x;
    const dy = point.y - source.y;
    const distanceSq = dx * dx + dy * dy;
    const captureDistanceSq = source.captureDistance * source.captureDistance;
    if (distanceSq >= captureDistanceSq) continue;
    const score = distanceSq / captureDistanceSq;
    if (score < nearestScore) {
      nearest = { ...source, dx, dy, distanceSq };
      nearestScore = score;
    }
  }
  return nearest;
}

function topologyLinkEndpointNode(graphData, endpoint) {
  if (endpoint && typeof endpoint === "object") return endpoint;
  const id = topologyEndpointId(endpoint);
  return (graphData.nodes || []).find((node) => node.id === id) || null;
}

function topologyRouteParticleSegments(width, height) {
  if (!topologyGraph) return [];
  const graphData = topologyGraph.graphData();
  return (graphData.links || [])
    .filter((link) => link.kind === "route" && link.tone !== "disabled")
    .map((link) => {
      const sourceNode = topologyLinkEndpointNode(graphData, link.source);
      const targetNode = topologyLinkEndpointNode(graphData, link.target);
      const source = topologyNodeScreenPosition(sourceNode, width, height);
      const target = topologyNodeScreenPosition(targetNode, width, height);
      if (!source || !target) return null;
      return {
        source,
        target,
        tone: link.tone || "green",
        direction: link.direction || "core_to_upstream",
        key: `${sourceNode.id}->${targetNode.id}:${link.direction || "core_to_upstream"}`
      };
    })
    .filter(Boolean);
}

function topologyStableOffset(value) {
  let hash = 0;
  const text = String(value || "");
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) % 9973;
  }
  return hash / 9973;
}

function updateTopologyBackgroundPoint(point, width, height) {
  point.x += point.vx;
  point.y += point.vy;

  if (point.x <= 0 || point.x >= width) {
    point.vx *= -1;
    point.x = Math.max(0, Math.min(width, point.x));
  }
  if (point.y <= 0 || point.y >= height) {
    point.vy *= -1;
    point.y = Math.max(0, Math.min(height, point.y));
  }
}

function updateTopologyNetworkPoint(point, width, height, sources) {
  const source = nearestTopologyNetworkSource(point, sources);
  if (source && source.distanceSq > 4) {
    const distance = Math.sqrt(source.distanceSq);
    const nx = source.dx / distance;
    const ny = source.dy / distance;
    const proximity = 1 - distance / source.captureDistance;
    const radiusError = distance - source.orbitRadius;
    const radial = -radiusError * source.radialForce;
    const tangent = proximity * source.orbitForce * (point.orbitSpeed || 1) * (point.orbitDir || 1);

    point.vx += nx * radial + -ny * tangent;
    point.vy += ny * radial + nx * tangent;
    point.x += nx * radial * 2.15;
    point.y += ny * radial * 2.15;

    if (Math.abs(radiusError) < 14) {
      point.vx *= 0.986;
      point.vy *= 0.986;
    }
  }

  const speed = Math.hypot(point.vx, point.vy);
  if (speed > TOPOLOGY_NETWORK_MAX_SPEED) {
    point.vx = (point.vx / speed) * TOPOLOGY_NETWORK_MAX_SPEED;
    point.vy = (point.vy / speed) * TOPOLOGY_NETWORK_MAX_SPEED;
  }

  point.x += point.vx;
  point.y += point.vy;

  if (point.x <= 0 || point.x >= width) {
    point.vx *= -1;
    point.x = Math.max(0, Math.min(width, point.x));
  }
  if (point.y <= 0 || point.y >= height) {
    point.vy *= -1;
    point.y = Math.max(0, Math.min(height, point.y));
  }
}

function drawTopologySourceLine(ctx, point, source, color) {
  if (!source) return;
  const maxDistance = source.captureDistance;
  const dx = point.x - source.x;
  const dy = point.y - source.y;
  const distanceSq = dx * dx + dy * dy;
  if (distanceSq > maxDistance * maxDistance) return;
  const distance = Math.sqrt(distanceSq);
  const alpha = Math.max(0, 1 - distance / maxDistance) * (source.type === "core" ? 0.24 : 0.32);
  ctx.strokeStyle = colorWithAlpha(color, alpha);
  ctx.lineWidth = source.type === "core" ? 0.62 : 0.72;
  ctx.beginPath();
  ctx.moveTo(point.x, point.y);
  ctx.lineTo(source.x, source.y);
  ctx.stroke();
}

function drawTopologyNetworkLine(ctx, a, b, maxDistance, baseAlpha, color, lineScale = 1) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const distanceSq = dx * dx + dy * dy;
  const maxDistanceSq = maxDistance * maxDistance;
  if (distanceSq > maxDistanceSq) return;
  const weight = (maxDistanceSq - distanceSq) / maxDistanceSq;
  const alpha = weight * baseAlpha;
  ctx.strokeStyle = colorWithAlpha(color, alpha);
  ctx.lineWidth = Math.max(0.28, weight * lineScale);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function drawTopologyBackgroundPoints(ctx, width, height, color) {
  topologyBackgroundPoints.forEach((point) => updateTopologyBackgroundPoint(point, width, height));

  for (let i = 0; i < topologyBackgroundPoints.length; i += 1) {
    const a = topologyBackgroundPoints[i];
    ctx.fillStyle = colorWithAlpha(color, 0.32);
    ctx.fillRect(a.x - a.size / 2, a.y - a.size / 2, a.size, a.size);

    for (let j = i + 1; j < topologyBackgroundPoints.length; j += 1) {
      drawTopologyNetworkLine(ctx, a, topologyBackgroundPoints[j], TOPOLOGY_BACKGROUND_POINT_LINK_DISTANCE, 0.16, color, 0.44);
    }
  }
}

function drawTopologyRouteParticle(ctx, segment, t, color) {
  const sx = segment.source.x;
  const sy = segment.source.y;
  const tx = segment.target.x;
  const ty = segment.target.y;
  const x = sx + (tx - sx) * t;
  const y = sy + (ty - sy) * t;
  const tail = Math.max(0, t - 0.09);
  const tailX = sx + (tx - sx) * tail;
  const tailY = sy + (ty - sy) * tail;
  const bright = segment.direction === "upstream_to_core" ? 0.78 : 0.86;

  ctx.strokeStyle = colorWithAlpha(color, 0.34);
  ctx.lineWidth = segment.direction === "upstream_to_core" ? 1.2 : 1.45;
  ctx.beginPath();
  ctx.moveTo(tailX, tailY);
  ctx.lineTo(x, y);
  ctx.stroke();

  const glow = ctx.createRadialGradient(x, y, 0, x, y, 9);
  glow.addColorStop(0, colorWithAlpha(color, bright));
  glow.addColorStop(0.42, colorWithAlpha(color, 0.34));
  glow.addColorStop(1, colorWithAlpha(color, 0));
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(x, y, 9, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = colorWithAlpha(color, 0.96);
  ctx.beginPath();
  ctx.arc(x, y, segment.direction === "upstream_to_core" ? 2.1 : 2.5, 0, Math.PI * 2);
  ctx.fill();
}

function drawTopologyRouteParticles(ctx, width, height) {
  const segments = topologyRouteParticleSegments(width, height);
  const now = performance.now();
  segments.forEach((segment, index) => {
    const color = topologyColor(segment.tone);
    const phase = topologyStableOffset(`${segment.key}:${index}`);
    const speed = (segment.tone === "pressure" || segment.tone === "red") ? TOPOLOGY_ROUTE_PARTICLE_SPEED * 1.5 : TOPOLOGY_ROUTE_PARTICLE_SPEED;
    const count = segment.direction === "upstream_to_core" ? 2 : 3;
    for (let i = 0; i < count; i += 1) {
      const progress = now * speed + phase + i / count;
      const t = progress % 1;
      drawTopologyRouteParticle(ctx, segment, t, color);
    }
  });
}

function drawTopologyNetworkFrame() {
  topologyNetworkFrame = 0;
  if (document.body.dataset.theme !== "mesh-topology") return;
  const size = syncTopologyNetworkCanvas();
  if (!size || !topologyNetworkCtx) return;
  const { width, height } = size;
  const ctx = topologyNetworkCtx;
  const primary = cssValue("--primary");
  ctx.clearRect(0, 0, width, height);

  const sources = topologyNetworkSources(width, height);
  topologyNetworkPoints.forEach((point) => updateTopologyNetworkPoint(point, width, height, sources));

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  drawTopologyBackgroundPoints(ctx, width, height, primary);

  for (let i = 0; i < topologyNetworkPoints.length; i += 1) {
    const a = topologyNetworkPoints[i];
    drawTopologySourceLine(ctx, a, nearestTopologyNetworkSource(a, sources), primary);
    ctx.fillStyle = colorWithAlpha(primary, 0.68);
    ctx.fillRect(a.x - a.size / 2, a.y - a.size / 2, a.size, a.size);

    for (let j = i + 1; j < topologyNetworkPoints.length; j += 1) {
      drawTopologyNetworkLine(ctx, a, topologyNetworkPoints[j], TOPOLOGY_NETWORK_POINT_LINK_DISTANCE, 0.32, primary, 0.68);
    }
  }
  drawTopologyRouteParticles(ctx, width, height);
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
      <span>${capacityRunText(metrics.capacity, metrics.running)}</span>
      <span>waiting ${fmt(metrics.waiting)}</span>
      <span>${escapeHTML(metrics.capacity?.label || "legacy capacity")}</span>
      <span>cache ${fmt(route.selected_by_cache || 0)} load picks ${fmt(route.selected_by_load || 0)}</span>
      <span>attempt ${fmt(route.upstream_attempts || 0)} • 429 ${fmt(route.upstream_429 || 0)}</span>
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
    <div class="topology-hint mono">drag canvas / scroll zoom / drag nodes / click node to edit</div>
  `;
  topologyNetworkCanvas = canvas.querySelector(".topology-network-canvas");
  topologyGraphContainer = canvas.querySelector(".topology-graph");
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
    .distance((link) => link.kind === "mesh" ? 235 : 280)
    .strength((link) => link.kind === "mesh" ? 0.01 : link.direction === "upstream_to_core" ? 0 : 0.035);
  topologyGraph.d3Force("center").strength(0.04);
  topologyGraph.d3Force("core-gap", topologyCoreGapForce(255));
  topologyGraph.d3Force("layout-bias", topologyLayoutBiasForce());

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
  const gatewayError = snapshot.gateway?.error ? ` | gateway error: ${snapshot.gateway.error}` : "";
  setStatus(`${router.label || router.id || ""} ${router.url || ""} | ${snapshot.generated_at || ""}${gatewayError}`.trim());
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
    if (snapshot.gateway?.error) log(snapshot.gateway.error, "err");
    else if (snapshot.gateway?.warning) log(snapshot.gateway.warning, "warn");
    else log("");
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
  resetPigPolicy(node.name ? "policy not loaded" : "select a node");
}

function selectedPolicyNodeID() {
  return selectedId || $("node-name").value.trim();
}

function setPigPolicyMessage(text, klass) {
  const el = $("pig-policy-message");
  el.textContent = text || "";
  el.className = `subline mono ${klass || ""}`.trim();
}

function setPigPolicyButtons(disabled) {
  $("pig-policy-refresh-btn").disabled = Boolean(disabled);
  $("pig-policy-save-btn").disabled = Boolean(disabled);
}

function resetPigPolicy(message) {
  latestPigPolicy = null;
  latestPigPolicyNode = selectedPolicyNodeID();
  $("pig-policy-target").textContent = latestPigPolicyNode ? latestPigPolicyNode : "select a node";
  $("pig-tps-reference").value = "";
  $("pig-policy-revision").textContent = "-";
  $("pig-policy-revision").dataset.revision = "";
  $("pig-policy-source").textContent = "-";
  $("pig-policy-mode").textContent = "-";
  $("pig-policy-poll").textContent = "-";
  $("pig-policy-age").textContent = "-";
  setPigPolicyButtons(!latestPigPolicyNode);
  setPigPolicyMessage(message || (latestPigPolicyNode ? "policy not loaded" : "select a node"));
}

function renderPigPolicy(nodeID, policy) {
  latestPigPolicy = policy || null;
  latestPigPolicyNode = nodeID || "";
  rememberPigPolicy(nodeID, policy);
  const mutable = policy?.mutable || {};
  const effective = policy?.effective || {};
  const revision = policy?.revision ?? "";
  $("pig-policy-target").textContent = latestPigPolicyNode || "select a node";
  $("pig-tps-reference").value = mutable.tps_reference ?? "";
  $("pig-policy-revision").textContent = fmt(revision);
  $("pig-policy-revision").dataset.revision = String(revision || "");
  $("pig-policy-source").textContent = policy?.source || "-";
  $("pig-policy-mode").textContent = effective.admission_mode || "-";
  $("pig-policy-poll").textContent = Number.isFinite(Number(effective.observation_poll_interval_ms))
    ? `${fmt(Number(effective.observation_poll_interval_ms))}ms`
    : "-";
  $("pig-policy-age").textContent = Number.isFinite(Number(effective.maximum_metrics_age_ms))
    ? `${fmt(Number(effective.maximum_metrics_age_ms))}ms`
    : "-";
  setPigPolicyButtons(!latestPigPolicyNode);
  const updated = policy?.updated_at ? ` updated ${policy.updated_at}` : "";
  setPigPolicyMessage(`loaded${updated}; persistence ${policy?.persistence || "-"}`, "ok");
}

async function readPigPolicy() {
  const nodeID = selectedPolicyNodeID();
  if (!nodeID) {
    resetPigPolicy("select a node first");
    return null;
  }
  setPigPolicyButtons(true);
  setPigPolicyMessage("reading policy...");
  try {
    const policy = await api(`/api/pig-policy?node=${encodeURIComponent(nodeID)}`);
    renderPigPolicy(nodeID, policy);
    return policy;
  } catch (err) {
    setPigPolicyButtons(false);
    setPigPolicyMessage(err.message, "err");
    throw err;
  }
}

async function savePigPolicy() {
  const nodeID = selectedPolicyNodeID();
  const revision = Number(latestPigPolicy?.revision || $("pig-policy-revision").dataset.revision);
  if (!nodeID) throw new Error("select a node first");
  const tpsReference = parseTPSReferenceInput($("pig-tps-reference").value);
  setPigPolicyButtons(true);
  setPigPolicyMessage("applying policy...");
  try {
    const payload = Number.isFinite(revision) && revision > 0
      ? { expected_revision: revision, tps_reference: tpsReference }
      : { tps_reference: tpsReference };
    const policy = await api(`/api/pig-policy?node=${encodeURIComponent(nodeID)}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    });
    renderPigPolicy(nodeID, policy);
    log(`PIG policy updated for ${nodeID}: tps_reference=${fmt(tpsReference)} revision=${fmt(policy.revision)}`, "ok");
    return policy;
  } catch (err) {
    setPigPolicyButtons(false);
    setPigPolicyMessage(err.message, "err");
    throw err;
  }
}

function parseTPSReferenceInput(value) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error("TPS reference must be an integer in [0, 1000000]");
  const tpsReference = Number(raw);
  if (!Number.isInteger(tpsReference) || tpsReference < 0 || tpsReference > 1000000) {
    throw new Error("TPS reference must be an integer in [0, 1000000]");
  }
  return tpsReference;
}

async function setNodeTPS(id, value) {
  const tpsReference = parseTPSReferenceInput(value);
  if (!id) throw new Error("select a node first");
  const policy = await api(`/api/pig-policy?node=${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ tps_reference: tpsReference })
  });
  rememberPigPolicy(id, policy);
  if (latestPigPolicyNode === id) renderPigPolicy(id, policy);
  await refresh();
  log(`PIG TPS updated for ${id}: tps_reference=${fmt(tpsReference)} revision=${fmt(policy?.revision)}`, "ok");
  return policy;
}

function newNode() {
  selectedId = "";
  $("node-name").value = "";
  $("base-url").value = "";
  $("path").value = "/v1/chat/completions";
  applyRouterDefaults();
  resetPigPolicy("select a node");
  log("");
  setEditorOpen(true);
  $("node-name").focus();
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
  resetPigPolicy("select a node");
  await refresh();
});

$("theme-select").addEventListener("change", (event) => {
  applyTheme(event.target.value);
});

$("new-node-btn").addEventListener("click", newNode);
$("refresh-btn").addEventListener("click", refresh);
$("save-btn").addEventListener("click", saveForm);
$("load-btn").addEventListener("click", loadSelected);
$("raw-btn").addEventListener("click", showRawConfig);
$("save-raw-btn").addEventListener("click", saveRaw);
$("close-editor-btn").addEventListener("click", () => setEditorOpen(false));
$("pig-policy-refresh-btn").addEventListener("click", () => {
  readPigPolicy().catch((err) => log(err.message, "err"));
});
$("pig-policy-save-btn").addEventListener("click", () => {
  savePigPolicy().catch((err) => log(err.message, "err"));
});

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
    if (button.dataset.action === "policy") {
      loadNode(node);
      if (document.body.dataset.theme === "mesh-topology") setEditorOpen(true);
      await readPigPolicy();
    }
    if (button.dataset.action === "toggle") await setEnabled(id, !(node && node.enabled));
    if (button.dataset.action === "set-tps") {
      const input = container.querySelector('input[data-role="tps-reference"]');
      await setNodeTPS(id, input ? input.value : "");
    }
    if (button.dataset.action === "delete") await deleteNode(id);
  } catch (err) {
    log(err.message, "err");
  }
});

resetPigPolicy("select a node");
applyTheme(preferredTheme());

loadRouters()
  .then(refresh)
  .catch((err) => {
    setStatus("load failed");
    log(err.message, "err");
  });

setInterval(refresh, 2000);
