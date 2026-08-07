# Phala Router Admin Page

Small authenticated admin UI for managing Phala router upstream nodes.

This repository is intentionally a standalone application. The deployment
compose file only starts the service and injects environment variables; HTML,
CSS, JavaScript, and server logic live in this repository instead of being
embedded into a Phala deployment YAML.

## Runtime

- Node.js 22
- No npm dependencies
- Basic Auth for the page
- Bearer token when calling router admin endpoints
- Backward-compatible capacity display for legacy PIG limits and request-aware
  PIG admission (`open`, `protected`, and `invalid` protocol states)

The runtime page treats `global_limit=0` as a request-aware sentinel only when
the Router reports `predictive_admission_enforce=true`. It displays Router
selectability, effective running, reservations, dispatch debt, attempts, and
upstream 429 counters instead of rendering request-aware open as `running / 0`.

## Configuration

Create `.env` from `.env.example`, then create `config/routers.json` from
`config/routers.example.json`.

Required environment variables:

- `GATEWAY_ADMIN_TOKEN`: Bearer token for router admin APIs.
- `BASIC_AUTH_USER`: Basic Auth user for this admin page.
- `BASIC_AUTH_PASSWORD_SHA256`: SHA-256 hash of the Basic Auth password.

Optional environment variables:

- `PORT`: HTTP listen port, default `8080`.
- `METRICS_TIMEOUT_MS`: timeout for upstream metrics requests, default `2500`.
- `ROUTERS_FILE`: JSON file with router definitions.
- `ROUTERS_JSON`: inline router JSON fallback when `ROUTERS_FILE` is not used.

## Local Check

```bash
node --check server.js
npm test
docker compose config
```
