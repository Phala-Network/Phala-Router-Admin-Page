# Phala Node Admin Page

Small authenticated admin UI for operating Phala nodes that are already present
in Redpill and for hot-updating the corresponding PIG policy.

This repository is intentionally a standalone application. HTML, CSS,
JavaScript, and server logic live in this repository instead of being embedded
into a Phala deployment YAML.

## Scope

This application has two responsibilities:

- Redpill listing control for existing Phala deployments.
- PIG runtime observation and hot policy updates for those Phala deployments.

The Redpill side is deliberately narrow. It only shows deployments that look
like Phala nodes by provider name or `phala.com` endpoint, and it only changes
their active state. It does not create nodes, edit endpoints, edit costs, edit
weights, or manage other providers.

The PIG side reads `/pig/metrics` from active Phala listings and exposes a
small proxy to `/admin/v1/predictive-policy` for:

- `tps_reference`
- `window_concurrency`
- `running_limit`

## Runtime

- Node.js 22
- No npm dependencies
- Basic Auth for the page
- Redpill admin API key is used only by the server process
- PIG bearer token is used only by the server process
- No Redpill or PIG secrets are sent to the browser
- Gateway/control/web cache propagation is internal to write operations and is
  not exposed as a manual node-management surface in the browser

## Request Model

The UI keeps Redpill requests low:

- models are cached server-side for `REDPILL_MODEL_CACHE_TTL_MS`;
- per-model deployments are cached server-side for
  `REDPILL_DEPLOYMENT_CACHE_TTL_MS`;
- normal page auto-refresh polls PIG metrics only;
- Redpill is refreshed manually or on the long cache interval;
- Redpill writes update the server-side deployment cache directly.

PIG metrics are short-cached by `PIG_METRICS_CACHE_TTL_MS` and stale metrics can
be reused for `PIG_METRICS_STALE_TTL_MS` so one temporarily slow node does not
break the whole page.

## Configuration

Create `.env` from `.env.example`.

Required environment variables:

- `BASIC_AUTH_USER`: Basic Auth user for this admin page.
- `BASIC_AUTH_PASSWORD_SHA256`: SHA-256 hash of the Basic Auth password.
- `REDPILL_API_URL`: Redpill admin API base URL, normally
  `https://service.redpill.ai`.
- `REDPILL_API_KEY`: Redpill admin API key.

Required for PIG metrics and policy:

- `PIG_ADMIN_TOKEN`: bearer token used to access Phala node `/pig/metrics` and
  `/admin/v1/predictive-policy`.

Optional environment variables:

- `PORT`: HTTP listen port, default `8080`.
- `PRIVATE_AI_CONTROL_URL`: control-plane admin URL for cache refresh.
- `REDPILL_WEB_URL`: Redpill web URL for ISR refresh.
- `REDPILL_WEB_REVALIDATE_TOKEN`: web revalidation token.
- `REDPILL_REQUEST_TIMEOUT_MS`: Redpill admin request timeout, default
  `15000`.
- `REDPILL_SYNC_AFTER_WRITE`: default sync behavior after writes, default
  `true`.
- `REDPILL_MODEL_CACHE_TTL_MS`: model list cache TTL, default `300000`.
- `REDPILL_DEPLOYMENT_CACHE_TTL_MS`: per-model deployment list cache TTL,
  default `300000`.
- `REDPILL_PHALA_PROVIDERS`: comma or whitespace separated provider names that
  count as Phala, default `phala`.
- `REDPILL_PHALA_HOST_SUFFIXES`: endpoint suffixes that count as Phala, default
  `phala.com`.
- `PIG_REQUEST_TIMEOUT_MS`: PIG request timeout, default `2500`.
- `PIG_METRICS_PATH`: PIG metrics path, default `/pig/metrics`.
- `PIG_POLICY_PATH`: PIG hot policy path, default
  `/admin/v1/predictive-policy`.
- `PIG_METRICS_CACHE_TTL_MS`: PIG metrics short cache TTL, default `1200`.
- `PIG_METRICS_STALE_TTL_MS`: stale PIG metrics reuse TTL, default `60000`.
- `ADMIN_BODY_LIMIT_BYTES`: admin page request body limit, default `1048576`.

## API

All endpoints require Basic Auth.

- `GET /api/health`
- `GET /api/models?q=&active=all|active|inactive`
- `GET /api/models/:id/deployments`
- `PATCH /api/deployments/:id/active`
- `POST /api/deployments/active-bulk`
- `GET /api/pig/snapshot?model_id=<id>`
- `GET /api/pig-policy?model_id=<id>&deployment_id=<id>`
- `PATCH /api/pig-policy?model_id=<id>&deployment_id=<id>`

## Operational Notes

All write actions in the browser show a confirmation dialog before execution.

For Redpill listing changes, select a model, then use a row `Up`/`Down` button
or select existing rows and run `Up selected` or `Down selected`. The server
verifies that every requested deployment belongs to the selected model and is a
Phala deployment before sending Redpill write requests. Successful writes can
automatically propagate Redpill gateway, control-plane, and web caches according
to `REDPILL_SYNC_AFTER_WRITE`; there is no separate manual sync or node-add
workflow in this UI.

For PIG policy changes, select a deployment with `PIG`, load the latest policy,
edit the three supported integers, then save. The server uses the policy
revision returned by PIG for optimistic concurrency. If the browser did not
load a revision, the server reads the latest revision and retries once on a
revision conflict.

## Local Check

```bash
npm run check
npm test
docker compose config
```
