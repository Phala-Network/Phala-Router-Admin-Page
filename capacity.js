"use strict";

function finiteNumber(value) {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstDefined(...values) {
  return values.find((value) => value !== null && value !== undefined);
}

function derivedCapacityProtocol(pig) {
  if (pig.predictive_admission_enforce !== true) return "legacy";
  const applied = pig.router_backpressure_applied;
  const limit = finiteNumber(pig.global_limit);
  if (applied === false && limit === 0) return "request_aware_open";
  if (applied === true && limit !== null && limit > 0) return "request_aware_protected";
  return "request_aware_invalid";
}

function resolvedCapacityProtocol(pig) {
  const derived = derivedCapacityProtocol(pig);
  const explicit = typeof pig.capacity_protocol === "string"
    ? pig.capacity_protocol.trim()
    : "";
  if (!explicit) return derived;
  if (explicit === "legacy") {
    return derived === "legacy" ? explicit : "request_aware_invalid";
  }
  if (["request_aware_open", "request_aware_protected", "request_aware_invalid"].includes(explicit)) {
    return explicit === derived ? explicit : "request_aware_invalid";
  }
  return "request_aware_invalid";
}

function mergeRouterPigMetrics(directPig = {}, route = {}) {
  const routerPig = route && route.pig_metrics && typeof route.pig_metrics === "object"
    ? route.pig_metrics
    : {};
  const merged = {
    ...directPig,
    ok: firstDefined(routerPig.ok, directPig.ok, false),
    stale: firstDefined(routerPig.stale, directPig.stale, false),
    error: firstDefined(routerPig.error, directPig.error, null),
    running: firstDefined(routerPig.raw_observed_running, routerPig.observed_running, directPig.running, null),
    waiting: firstDefined(routerPig.raw_observed_waiting, routerPig.observed_waiting, directPig.waiting, null),
    raw_running: firstDefined(routerPig.raw_observed_running, directPig.raw_running, null),
    raw_waiting: firstDefined(routerPig.raw_observed_waiting, directPig.raw_waiting, null),
    global_limit: firstDefined(routerPig.global_limit, directPig.global_limit, null),
    raw_global_limit: firstDefined(routerPig.raw_global_limit, directPig.raw_global_limit, null),
    basic_limit: firstDefined(routerPig.basic_limit, directPig.basic_limit, null),
    basic_inflight: firstDefined(routerPig.basic_inflight, directPig.basic_inflight, null),
    premium_inflight: firstDefined(routerPig.premium_inflight, directPig.premium_inflight, null),
    predictive_admission_enforce: firstDefined(
      routerPig.predictive_admission_enforce,
      directPig.predictive_admission_enforce,
      false
    ),
    router_backpressure_active: firstDefined(
      routerPig.router_backpressure_active,
      directPig.router_backpressure_active,
      false
    ),
    router_backpressure_applied: firstDefined(
      routerPig.router_backpressure_applied,
      directPig.router_backpressure_applied,
      null
    ),
    router_inspect_capacity: firstDefined(
      routerPig.router_inspect_capacity,
      directPig.router_inspect_capacity,
      null
    ),
    age_ms: firstDefined(routerPig.age_ms, directPig.age_ms, null)
  };
  merged.capacity_protocol = firstDefined(
    routerPig.capacity_protocol,
    directPig.capacity_protocol,
    derivedCapacityProtocol(merged)
  );
  return merged;
}

function buildCapacityView({ enabled, metricsStatus, route = {}, pig = {} }) {
  const protocol = resolvedCapacityProtocol(pig);
  const requestAware = protocol.startsWith("request_aware_");
  const routeSelectable = route.selectable !== false;
  const selectable = Boolean(enabled && routeSelectable);
  const effectiveRunning = firstDefined(route.effective_running, route.running, pig.running, 0);
  const limit = finiteNumber(pig.global_limit);
  const common = {
    protocol,
    request_aware: requestAware,
    selectable,
    running: firstDefined(pig.running, route.running, 0),
    effective_running: effectiveRunning,
    display_limit: protocol === "request_aware_open" ? null : limit,
    raw_global_limit: firstDefined(pig.raw_global_limit, null),
    backpressure_applied: firstDefined(pig.router_backpressure_applied, false),
    inspect_capacity: firstDefined(pig.router_inspect_capacity, null),
    fullness_milli: firstDefined(route.fullness_milli, 0),
    pending_reservations: firstDefined(route.pending_reservations, 0),
    dispatch_debt: firstDefined(route.unreconciled_dispatches, 0),
    upstream_attempts: firstDefined(route.upstream_attempts, 0),
    upstream_429: firstDefined(route.upstream_429, 0)
  };

  if (!enabled) {
    return { ...common, state: "disabled", label: "disabled", tone: "disabled", reason: "not in routing pool" };
  }
  if (pig.stale === true || metricsStatus === "metrics_stale") {
    return { ...common, state: "metrics_stale", label: "metrics stale", tone: "metrics_stale", reason: pig.error || "metrics are stale" };
  }
  if (pig.ok === false || metricsStatus === "metrics_error") {
    return { ...common, state: "metrics_error", label: "metrics error", tone: "metrics_error", reason: pig.error || "metrics unavailable" };
  }
  if (protocol === "request_aware_invalid") {
    return { ...common, state: "protocol_invalid", label: "protocol invalid", tone: "metrics_error", reason: "inconsistent request-aware metrics" };
  }
  if (protocol === "request_aware_protected") {
    return { ...common, state: "protected", label: "request-aware protected", tone: "pressure", reason: "PIG backpressure is protecting this upstream" };
  }
  if (protocol === "request_aware_open") {
    return { ...common, state: "open", label: "request-aware open", tone: selectable ? "healthy" : "pressure", reason: selectable ? "per-request admission is open" : "Router has temporarily blocked selection" };
  }
  if (!selectable) {
    return { ...common, state: "blocked", label: "legacy blocked", tone: "pressure", reason: "Router has no observable capacity" };
  }
  return { ...common, state: "legacy", label: "legacy capacity", tone: "healthy", reason: "count-based global limit" };
}

module.exports = {
  buildCapacityView,
  derivedCapacityProtocol,
  mergeRouterPigMetrics,
  resolvedCapacityProtocol
};
