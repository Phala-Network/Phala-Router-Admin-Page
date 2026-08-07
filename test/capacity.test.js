"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildCapacityView,
  derivedCapacityProtocol,
  mergeRouterPigMetrics,
  resolvedCapacityProtocol
} = require("../capacity");

test("legacy metrics keep their positive count limit", () => {
  const pig = mergeRouterPigMetrics({ ok: true, running: 8, global_limit: 20 }, {
    selectable: true,
    running: 7,
    effective_running: 8,
    pig_metrics: { capacity_protocol: "legacy", observed_running: 8, global_limit: 20 }
  });
  const view = buildCapacityView({ enabled: true, metricsStatus: "healthy", route: { selectable: true, effective_running: 8 }, pig });
  assert.equal(view.protocol, "legacy");
  assert.equal(view.display_limit, 20);
  assert.equal(view.state, "legacy");
  assert.equal(view.selectable, true);
});

test("request-aware open treats zero as a sentinel instead of a zero-sized limit", () => {
  const route = {
    selectable: true,
    running: 7,
    effective_running: 10,
    upstream_attempts: 100,
    upstream_429: 4,
    pig_metrics: {
      ok: true,
      capacity_protocol: "request_aware_open",
      predictive_admission_enforce: true,
      raw_observed_running: 8,
      raw_global_limit: 1,
      global_limit: 0,
      router_backpressure_applied: false,
      router_inspect_capacity: 0
    }
  };
  const pig = mergeRouterPigMetrics({ ok: true, running: 6, global_limit: 0 }, route);
  const view = buildCapacityView({ enabled: true, metricsStatus: "healthy", route, pig });
  assert.equal(pig.running, 8);
  assert.equal(view.protocol, "request_aware_open");
  assert.equal(view.display_limit, null);
  assert.equal(view.effective_running, 10);
  assert.equal(view.upstream_429, 4);
  assert.equal(view.state, "open");
  assert.equal(view.tone, "healthy");
});

test("request-aware protected uses the projected positive limit and Router selectability", () => {
  const route = {
    selectable: false,
    effective_running: 12,
    unreconciled_dispatches: 2,
    pig_metrics: {
      ok: true,
      capacity_protocol: "request_aware_protected",
      predictive_admission_enforce: true,
      observed_running: 9,
      global_limit: 6,
      router_backpressure_applied: true
    }
  };
  const pig = mergeRouterPigMetrics({ ok: true }, route);
  const view = buildCapacityView({ enabled: true, metricsStatus: "healthy", route, pig });
  assert.equal(view.state, "protected");
  assert.equal(view.display_limit, 6);
  assert.equal(view.selectable, false);
  assert.equal(view.dispatch_debt, 2);
  assert.equal(view.tone, "pressure");
});

test("inconsistent request-aware projections fail visibly", () => {
  const pig = {
    ok: true,
    predictive_admission_enforce: true,
    router_backpressure_applied: false,
    global_limit: 4
  };
  assert.equal(derivedCapacityProtocol(pig), "request_aware_invalid");
  const view = buildCapacityView({ enabled: true, metricsStatus: "healthy", route: { selectable: false }, pig });
  assert.equal(view.state, "protocol_invalid");
  assert.equal(view.tone, "metrics_error");
});

test("disabled inventory always wins over stale or misleading route fields", () => {
  const view = buildCapacityView({
    enabled: false,
    metricsStatus: "metrics_error",
    route: { selectable: true },
    pig: { ok: false, capacity_protocol: "request_aware_invalid" }
  });
  assert.equal(view.state, "disabled");
  assert.equal(view.selectable, false);
});

test("new metric fields can derive the protocol when Router admin fields are absent", () => {
  assert.equal(derivedCapacityProtocol({
    predictive_admission_enforce: true,
    router_backpressure_applied: false,
    global_limit: 0
  }), "request_aware_open");
  assert.equal(derivedCapacityProtocol({
    predictive_admission_enforce: true,
    router_backpressure_applied: true,
    global_limit: 5
  }), "request_aware_protected");
});

test("missing limits stay missing instead of becoming zero", () => {
  const pig = mergeRouterPigMetrics({ ok: true, running: 3 }, {
    selectable: true,
    effective_running: 3,
    pig_metrics: { capacity_protocol: "legacy", observed_running: 3 }
  });
  const view = buildCapacityView({ enabled: true, metricsStatus: "healthy", route: { selectable: true }, pig });
  assert.equal(view.display_limit, null);
  assert.equal(view.protocol, "legacy");
});

test("explicit protocol fields must agree with their request-aware invariants", () => {
  assert.equal(resolvedCapacityProtocol({
    capacity_protocol: "request_aware_open",
    predictive_admission_enforce: true,
    router_backpressure_applied: true,
    global_limit: 6
  }), "request_aware_invalid");
  assert.equal(resolvedCapacityProtocol({
    capacity_protocol: "future_protocol",
    predictive_admission_enforce: false,
    global_limit: 20
  }), "request_aware_invalid");
});
