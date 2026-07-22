"use strict";

let routers = [];
let selectedId = "";
let latestSnapshot = null;
let refreshInFlight = false;

const $ = (id) => document.getElementById(id);

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

function barClass(value, limit) {
  const p = pct(value, limit);
  if (p >= 95) return "red";
  if (p >= 75) return "yellow";
  return "";
}

function meter(value, limit, subline) {
  const p = pct(value, limit);
  const klass = barClass(value, limit);
  return `
    <div class="mono">${fmt(value)}${limit !== null && limit !== undefined ? " / " + fmt(limit) : ""}</div>
    <div class="bar ${klass}" style="--w:${p}%"><span></span></div>
    ${subline ? `<div class="subline mono">${subline}</div>` : ""}
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
    ["nodes", summary.nodes],
    ["enabled", summary.enabled_nodes],
    ["router run", summary.router_running],
    ["PIG run", summary.pig_running],
    ["backend run", summary.backend_running],
    ["waiting", summary.waiting],
    ["cache", summary.cache_selected],
    ["load", summary.load_selected]
  ];
  $("summary").innerHTML = items.map(([label, value]) => `
    <div class="stat">
      <div class="label">${label}</div>
      <div class="value">${fmt(value)}</div>
    </div>
  `).join("");
}

function renderNode(node) {
  const route = node.route || {};
  const pig = node.runtime?.pig || {};
  const backend = node.runtime?.backend || {};
  const routerLimit = pig.global_limit ?? backend.running ?? route.running;
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
      <td>${node.enabled ? meter(pig.running, pig.global_limit) : meter(null, null)}</td>
      <td>${node.enabled ? meter(backend.running, pig.global_limit, `waiting ${fmt(backend.waiting)} kv ${fmt(backend.kv_usage)}`) : meter(null, null, "waiting - kv -")}</td>
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

function render(snapshot) {
  latestSnapshot = snapshot;
  renderSummary(snapshot.summary || {});
  $("nodes-body").innerHTML = (snapshot.nodes || []).map(renderNode).join("");
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

$("refresh-btn").addEventListener("click", refresh);
$("save-btn").addEventListener("click", saveForm);
$("load-btn").addEventListener("click", loadSelected);
$("raw-btn").addEventListener("click", showRawConfig);
$("save-raw-btn").addEventListener("click", saveRaw);

$("nodes-body").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const row = button.closest("tr[data-node]");
  if (!row) return;
  const id = row.dataset.node;
  const node = nodeById(id);
  selectedId = id;
  try {
    if (button.dataset.action === "load") loadNode(node);
    if (button.dataset.action === "toggle") await setEnabled(id, !(node && node.enabled));
    if (button.dataset.action === "delete") await deleteNode(id);
  } catch (err) {
    log(err.message, "err");
  }
});

loadRouters()
  .then(refresh)
  .catch((err) => {
    setStatus("load failed");
    log(err.message, "err");
  });

setInterval(refresh, 2000);
