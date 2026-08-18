# OCPP 1.6J Central System (CSMS)

TypeScript / Express / WebSocket / MongoDB backend for EV charge points speaking
**OCPP 1.6-J** (JSON over WebSocket), including the security extensions from the
OCA white paper *"Improved security for OCPP 1.6-J", edition 2 (2020-03-31)*.

Charge points connect over WebSocket. Your dashboard, mobile app or billing
system talks to the REST API. Both are served by the same process on one port.

```
charge point  ──ws://host:3000/ocpp/{chargePointId}──►  ┌──────────────┐
                                                        │  this server │──► MongoDB
dashboard     ──http://host:3000/api/...─────────────►  └──────────────┘
                   + SSE live event stream
```

---

## Quick start

```bash
npm install
cp .env.example .env          # then edit JWT_SECRET and MONGODB_URI
npm run seed -- --ca          # admin user, demo charge point/tags, local CA
npm run dev
```

Smoke-test it with the bundled charge point simulator (in a second terminal):

```bash
npm run simulator -- --id CP-DEMO-001 --url ws://127.0.0.1:3000/ocpp --key <AuthorizationKey printed by seed>
```

`npm run seed` prints the generated `AuthorizationKey` for the demo charge point.
It is only ever stored hashed, so copy it when it appears.

---

## What is implemented

### Charge Point → Central System

| Action | Effect |
|---|---|
| `BootNotification` | registers/updates the charge point, returns heartbeat interval, closes transactions orphaned by the reboot |
| `Heartbeat` | liveness tracking |
| `Authorize` | idTag lookup: status, expiry, parent tag, concurrent-transaction limit, per-charge-point allow list |
| `StartTransaction` | allocates an integer `transactionId`, marks the connector busy, consumes a reservation |
| `StopTransaction` | closes the session, computes energy and cost, stores `transactionData` |
| `MeterValues` | stores every sampled value; rolls up energy / power / SoC onto the transaction and connector |
| `StatusNotification` | per-connector status, error code and vendor error |
| `DataTransfer` | logged, answers `UnknownVendorId` (add your vendor extensions in `handlers/core.ts`) |
| `FirmwareStatusNotification` | updates the matching firmware job |
| `DiagnosticsStatusNotification` | updates the matching diagnostics job |
| `SecurityEventNotification` | persists the event, flags criticality per white paper §8 |
| `SignCertificate` | accepts the CSR, signs it with the local CA, pushes `CertificateSigned.req` back |
| `LogStatusNotification` | updates the matching `GetLog` job |
| `SignedFirmwareStatusNotification` | updates the matching signed-firmware job |

### Central System → Charge Point

Every action is exposed as `POST /api/charge-points/:id/<command>`:

**Core** — `remote-start`, `remote-stop`, `reset`, `unlock-connector`,
`change-availability`, `change-configuration`, `get-configuration`,
`clear-cache`, `data-transfer`
**Remote trigger** — `trigger-message`, `extended-trigger-message`
**Reservation** — `reserve-now`, `cancel-reservation`
**Smart charging** — `set-charging-profile`, `clear-charging-profile`, `get-composite-schedule`
**Local auth list** — `send-local-list`, `get-local-list-version`
**Firmware / diagnostics** — `update-firmware`, `get-diagnostics`, `signed-update-firmware`, `get-log`
**Certificates** — `install-certificate`, `delete-certificate`, `get-installed-certificate-ids`, `certificate-signed`
**Escape hatch** — `raw` (`{ "action": "...", "payload": {...} }`) for anything else

Responses are the charge point's actual OCPP `.conf` payload. Side effects are
persisted automatically: an accepted `ReserveNow` creates a reservation, an
accepted `SetChargingProfile` stores the profile, `GetConfiguration` caches the
returned keys, and so on.

### Security (OCA white paper, edition 2)

- **Security profile 1** — HTTP Basic on the WebSocket upgrade; username must
  equal the charge point identity (A00.FR.204), password is the
  `AuthorizationKey` stored bcrypt-hashed (A00.FR.205).
- **Security profile 2** — the same over TLS; server enforces TLS ≥ 1.2
  (A00.FR.312) and the cipher suites of A00.FR.317.
- **Security profile 3** — mutual TLS; the client certificate CN must equal the
  charge point identity, otherwise the upgrade is refused.
- Rejected authentications raise a `FailedToAuthenticateAtCentralSystem` /
  `InvalidChargePointCertificate` security event.
- **Key rotation** (use case A01): `POST /api/charge-points/:id/rotate-authorization-key`
  generates a new key, stores its hash and pushes `ChangeConfiguration(AuthorizationKey)`.
  The value is never written to the configuration cache (A01.FR.11).
- **Certificate signing** (A02 / A03): a built-in CA signs charge point CSRs and
  returns the leaf + CA chain via `CertificateSigned.req`. Point `CSMS_CA_*` at
  your real PKI material to use your own CA instead.
- **Security log**: every event is stored with its criticality; query and
  acknowledge them under `/api/security/events`.

---

## REST API

All endpoints except `/health`, `/api` and `/api/auth/login` need
`Authorization: Bearer <jwt>` (or `x-api-key: <API_KEY>` for machine access).

```
POST   /api/auth/login                      { email, password } -> { token, user }
GET    /api/auth/me
GET    /api/auth/users                      (ADMIN)
POST   /api/auth/users                      (ADMIN)

GET    /api/charge-points                   ?search=&online=true&page=&limit=
POST   /api/charge-points                   (OPERATOR) -> returns authorizationKey once
GET    /api/charge-points/:id               charge point + connectors + active sessions + config
PATCH  /api/charge-points/:id               (OPERATOR)
DELETE /api/charge-points/:id               (ADMIN)
POST   /api/charge-points/:id/rotate-authorization-key   (ADMIN)
POST   /api/charge-points/:id/disconnect    (OPERATOR)
GET    /api/charge-points/:id/connectors
GET    /api/charge-points/:id/messages      raw OCPP frame audit trail
GET    /api/charge-points/:id/commands      outgoing commands + their results
POST   /api/charge-points/:id/<command>     (OPERATOR) see the command list above

GET    /api/connectors                      ?chargePointId=&status=
GET    /api/transactions                    ?chargePointId=&idTag=&status=&from=&to=
GET    /api/transactions/active
GET    /api/transactions/:id
GET    /api/transactions/:id/meter-values   ?measurand=Power.Active.Import
POST   /api/transactions/:id/stop           (OPERATOR) RemoteStopTransaction
POST   /api/transactions/:id/force-close    (OPERATOR) close in the DB only

GET    /api/meter-values                    ?transactionId=&measurand=&from=&to=
GET    /api/id-tags                         ?search=&status=
POST   /api/id-tags                         (OPERATOR)
POST   /api/id-tags/bulk                    (OPERATOR) up to 5000 tags
PATCH  /api/id-tags/:idTag                  (OPERATOR)
DELETE /api/id-tags/:idTag                  (OPERATOR)
POST   /api/id-tags/:idTag/authorize-check  dry-run the authorization logic

GET    /api/reservations                    ?chargePointId=&state=
GET    /api/charging-profiles               ?chargePointId=
GET    /api/jobs/firmware                   ?chargePointId=
GET    /api/jobs/diagnostics                ?chargePointId=

GET    /api/security/events                 ?type=&critical=true&acknowledged=false
GET    /api/security/events/summary
POST   /api/security/events/:id/acknowledge (OPERATOR)
GET    /api/security/certificates           ?chargePointId=&type=
POST   /api/security/certificates/inspect   PEM -> CertificateHashDataType
GET    /api/security/ca
POST   /api/security/ca/generate            (ADMIN)
GET    /api/security/csrs                   ?status=Pending
POST   /api/security/csrs/:id/sign          (OPERATOR)
POST   /api/security/csrs/:id/reject        (OPERATOR)

GET    /api/stats/overview
GET    /api/stats/energy-series             ?days=30&chargePointId=
GET    /api/stats/top-charge-points         ?days=30

GET    /api/events/stream                   Server-Sent Events (live)
GET    /health
GET    /api                                 capability discovery
```

Roles: `VIEWER` (read), `OPERATOR` (+ commands and data changes), `ADMIN` (+ users,
deletion, key rotation, CA).

### Live event stream

`EventSource` cannot set headers, so pass the JWT as a query parameter:

```js
const es = new EventSource(`/api/events/stream?token=${jwt}&chargePointId=CP-DEMO-001`);
es.addEventListener('transaction.metervalue', (e) => console.log(JSON.parse(e.data)));
```

Events: `chargepoint.connected`, `chargepoint.disconnected`, `chargepoint.boot`,
`chargepoint.heartbeat`, `connector.status`, `transaction.started`,
`transaction.stopped`, `transaction.metervalue`, `security.event`,
`firmware.status`, `diagnostics.status`, `log.status`, `command.result`,
`ocpp.message`. Filter with `?events=a,b,c`.

---

## Deploying on Ubuntu

```bash
sudo apt update && sudo apt install -y mongodb-org      # or use your existing MongoDB
git clone <your repo> /opt/csms && cd /opt/csms
npm ci
cp .env.example .env && $EDITOR .env                    # JWT_SECRET, MONGODB_URI, security profile
npm run build
npm run seed -- --ca
```

`/etc/systemd/system/csms.service`:

```ini
[Unit]
Description=OCPP 1.6J Central System
After=network.target mongod.service

[Service]
Type=simple
User=csms
WorkingDirectory=/opt/csms
EnvironmentFile=/opt/csms/.env
ExecStart=/usr/bin/node dist/src/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now csms
```

Or with Docker: `docker compose up -d --build` (starts MongoDB too).

### TLS

Either terminate TLS at nginx (keep `TLS_ENABLED=false` and set
`OCPP_SECURITY_PROFILE=2`) — remember to proxy the WebSocket upgrade:

```nginx
location /ocpp/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 3600s;
}
```

— or let Node terminate it by setting `TLS_ENABLED=true` and the `TLS_*` paths.
For **security profile 3**, Node must terminate TLS so it can read the client
certificate; set `OCPP_SECURITY_PROFILE=3` and `TLS_CA_PATH` to the CA that
issued your charge point certificates.

---

## Configuration

See `.env.example` for the full list. The ones that matter most:

| Variable | Meaning |
|---|---|
| `MONGODB_URI` | MongoDB connection string |
| `JWT_SECRET` | **must** be changed; ≥ 16 characters |
| `OCPP_SECURITY_PROFILE` | 1, 2 or 3 (see above) |
| `OCPP_ALLOW_ANONYMOUS` | `true` lets unknown charge points self-register without a password. Fine for commissioning, **turn it off in production** |
| `OCPP_REQUIRE_KNOWN_CHARGEPOINT` | reject any charge point not already in the database |
| `OCPP_CALL_TIMEOUT_MS` | how long a REST command waits for the charge point (returns HTTP 504 on timeout) |
| `OCPP_LOG_MESSAGES` | persist every OCPP frame; `OCPP_LOG_RETENTION_DAYS` sets the TTL |

---

## Project layout

```
src/
  index.ts                 HTTP/HTTPS server, TLS, graceful shutdown
  config/env.ts            validated environment
  lib/                     db, logger, errors, atomic counters
  models/                  Mongoose schemas
  ocpp/
    types.ts               OCPP-J framing and RPC error codes
    schemas/               zod schemas for all 39 messages (core, profiles, security)
    connection.ts          one socket: framing, validation, call queue, timeouts, audit
    manager.ts             live connection registry
    server.ts              upgrade handling and security-profile authentication
    handlers/              inbound message handlers
  services/                authorization, transactions, meter values, security, CA
  api/                     Express app, middleware, routers
  realtime/events.ts       internal event bus feeding the SSE stream
scripts/
  seed.ts                  admin user, demo data, CA generation
  simulator.ts             charge point simulator for testing
```

### Notes and limits

- **Single process.** Live sockets are held in memory, so a REST command can
  only reach a charge point connected to the same instance. To scale out, pin
  charge points to an instance (sticky routing on the URL) or add a broker
  between instances.
- **`DataTransfer` from charge points** answers `UnknownVendorId`. Implement your
  vendor extensions in `src/ocpp/handlers/core.ts`.
- **Charge point identity** comes from the connect URL and must match
  `^[\w.:@-]+$`, max 64 characters.
- Only one outstanding CALL per connection is in flight at a time, as OCPP-J
  requires; further commands queue automatically.
