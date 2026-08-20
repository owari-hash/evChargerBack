# OCPP 1.6J Central System (CSMS)

TypeScript / Express / WebSocket / MongoDB backend for EV charge points speaking
**OCPP 1.6-J** (JSON over WebSocket), including the security extensions from the
OCA white paper *"Improved security for OCPP 1.6-J", edition 2 (2020-03-31)*.

Charge points connect over WebSocket. Your dashboard, mobile app or billing
system talks to the REST API. Both are served by the same process on one port.

```
charge point  ──wss://eplug.mn/ocpp/{chargePointId}──►  ┌──────────────┐
                                                        │  this server │──► MongoDB
dashboard     ──https://eplug.mn/api/...─────────────►  └──────────────┘
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

## Base URL

Every REST route is mounted under `API_BASE_PATH` (default `/api`), so the same
paths work locally and in production:

| Environment | REST | Charge points |
|---|---|---|
| local | `http://localhost:3000/api/...` | `ws://localhost:3000/ocpp/{chargePointId}` |
| eplug.mn | `https://eplug.mn/api/...` | `wss://eplug.mn/ocpp/{chargePointId}` |

nginx proxies `/api/` to the backend **without stripping the prefix** — the app
serves `/api` itself — so a client only has to swap the origin. A ready-made site
config is in [`deploy/nginx-eplug.mn.conf`](deploy/nginx-eplug.mn.conf); install
it with [`deploy/install-nginx-ubuntu.sh`](deploy/install-nginx-ubuntu.sh) (see
**TLS** below).

### Sharing the origin with the two front ends

`eplug.mn` serves three processes behind the one certificate:

| Path | Process | Port |
|---|---|---|
| `/` | driver web app (`../evChargerKiosk`) | 3100 |
| `/app-api/*` | …its own JSON API, same process | 3100 |
| `/admin`, `/admin/*` | admin console (`../evChargerAdmin`) | 3001 |
| `/admin/console-api/*` | …its own JSON API, same process | 3001 |
| `/api/*`, `/ocpp/*`, `/health` | this backend | 3000 |

Two rules keep them from colliding, and both are load-bearing:

1. **`/api/*` belongs to the CSMS alone.** Next.js route handlers default to
   `/api/*`, which on a shared origin would be shadowed by this backend. That is
   why the driver app serves its routes at `/app-api/*` and the console at
   `/console-api/*`. Moving either back to `/api` breaks it silently — nginx
   routes the request here and the front end sees a 404 it never sent.
2. **The console is built with `basePath: /admin`.** A second Next.js app cannot
   simply be mounted on a sub-path by nginx: both apps emit absolute
   `/_next/static/...` URLs and would fight over them. `basePath` makes the
   console emit `/admin/_next/...` instead. It is baked in at build time from
   `NEXT_PUBLIC_BASE_PATH`, so changing the mount point means rebuilding the
   console, not just editing nginx.

`PUBLIC_BASE_URL` (default `https://eplug.mn`) is the origin the API reports in
`GET /api` and in the startup log; it does not change routing. Health is served
at both `/health` and `/api/health` so it stays reachable through the proxy.

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

GET    /api/payments/config                 QPay switches + cached token expiry (no secrets)
GET    /api/payments                        ?status=&chargePointId=&idTag=&transactionId=&from=&to=
POST   /api/payments                        (OPERATOR) create an invoice -> QR payload
POST   /api/payments/transactions/:id       (OPERATOR) invoice one charging session
GET    /api/payments/:id
GET    /api/payments/:id/qr                 qrText + base64 qrImage + wallet deeplinks
POST   /api/payments/:id/check              re-check with QPay (client polling)
POST   /api/payments/:id/cancel             (OPERATOR)
POST   /api/payments/:id/refund             (ADMIN)
POST   /api/payments/reconcile              (ADMIN) sweep invoices with no callback
ALL    /api/payments/callback/:id/:secret   QPay callback (unauthenticated, secret in path)

GET    /api/wallets/config                  presets, limits and switches for the top-up screens
GET    /api/wallets                         (OPERATOR) ?ownerType=&status=&negative=&q=
GET    /api/wallets/by-id-tag/:idTag        which wallet a card spends from
GET    /api/wallets/:ownerType/:ownerId     balance + totals + bound cards (created on first read)
GET    /api/wallets/:ownerType/:ownerId/balance    cheap poll for a balance badge
GET    /api/wallets/:ownerType/:ownerId/entries    ?type=&from=&to= ledger, newest first
POST   /api/wallets/:ownerType/:ownerId/topup      (OPERATOR) QPay invoice -> QR payload
POST   /api/wallets/:ownerType/:ownerId/id-tags    (OPERATOR) bind a card to this wallet
DELETE /api/wallets/:ownerType/:ownerId/id-tags/:idTag  (OPERATOR)
POST   /api/wallets/:ownerType/:ownerId/adjust     (ADMIN) signed manual correction
POST   /api/wallets/:ownerType/:ownerId/freeze     (ADMIN)
POST   /api/wallets/:ownerType/:ownerId/unfreeze   (ADMIN)

GET    /api/qpay/cities                     QuickQR: aimag/hot list
GET    /api/qpay/cities/:code/districts     QuickQR: sum/duureg list
GET    /api/qpay/merchants                  ?page=&limit=
POST   /api/qpay/merchants/company          (OPERATOR) onboard a company sub-merchant
POST   /api/qpay/merchants/person           (OPERATOR) onboard an individual sub-merchant
PUT    /api/qpay/merchants/company/:id      (OPERATOR)
PUT    /api/qpay/merchants/person/:id       (OPERATOR)
GET    /api/qpay/merchants/:id
DELETE /api/qpay/merchants/:id              (ADMIN)
GET    /api/qpay/tokens                     (ADMIN) token state, never the tokens
POST   /api/qpay/tokens/:scope/invalidate   (ADMIN) force a re-authentication

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
`firmware.status`, `diagnostics.status`, `log.status`, `payment.created`,
`payment.paid`, `payment.canceled`, `command.result`, `ocpp.message`. Filter with
`?events=a,b,c`.

---

## QPay payments

Two QPay APIs are wired up behind one token manager:

| | Host | Auth | Used for |
|---|---|---|---|
| **QuickQR** | `quickqr.qpay.mn` | HTTP Basic **+** `terminal_id` | sub-merchant onboarding, invoices, payment check |
| **Merchant** | `merchant.qpay.mn` / `merchant-sandbox.qpay.mn` | HTTP Basic | invoices, payment check, refunds |

`QPAY_DEFAULT_PROVIDER` picks which one new invoices go through. The credentials
in `.env` (`ZEV_TABS1`) authenticate against **QuickQR** — the merchant hosts
reject them with `NO_CREDENTIALS`, so ask QPay for merchant-API credentials
before switching `QPAY_DEFAULT_PROVIDER=merchant`.

### Token handling

`src/services/qpay/tokens.ts` is the only place tokens are touched:

- **One login per scope.** Concurrent callers share a single in-flight
  authentication, so a burst of payments does not trigger a burst of logins.
- **Refresh before expiry.** `POST /v2/auth/refresh` with
  `Authorization: Bearer <refresh_token>`, `QPAY_TOKEN_SKEW_SECONDS` (60s) early.
  QPay reports `expires_in` as an absolute UNIX timestamp, which is handled
  alongside the plain-duration form.
- **Encrypted at rest.** Tokens live in the `qpaytokens` collection as
  AES-256-GCM ciphertext keyed by `QPAY_TOKEN_SECRET` (or `JWT_SECRET`), with
  `select: false` and stripped from every JSON projection. Rotating the secret or
  the credentials invalidates the cache — a stored `credentialFingerprint`
  detects it — instead of failing every call.
- **Self-healing.** A `401`/`403` from QPay drops the cached token and retries the
  call exactly once.
- **Never logged.** `redact()` masks `access_token`, `refresh_token`, `password`
  and api-key fields in every log line; only a 4-character tail is ever printed.

`GET /api/payments/config` and `GET /api/qpay/tokens` expose expiry timestamps,
never the tokens themselves.

### Charging session → payment

```bash
# 1. Invoice a finished session (amount derived from cost or tariffPerKwh × kWh)
curl -X POST https://eplug.mn/api/payments/transactions/1042 \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d '{"receiverCode":"99112210"}'
# -> { id, status: "PENDING", qrText, shortUrl, deeplinks: [...] }

# 2. Render the QR (base64 PNG is kept out of the default payload)
curl https://eplug.mn/api/payments/<id>/qr -H "Authorization: Bearer $JWT"

# 3. Poll while the customer pays — or listen for payment.paid on the SSE stream
curl -X POST https://eplug.mn/api/payments/<id>/check -H "Authorization: Bearer $JWT"
```

An invoice for an arbitrary amount is `POST /api/payments` with
`{ "amount": 5000, "description": "..." }`. `senderInvoiceNo` is the idempotency
key: it is unique, and re-posting one returns the existing invoice rather than
billing the customer twice.

### Callbacks

QPay calls
`{PUBLIC_BASE_URL}/api/payments/callback/{QPAY_CALLBACK_TOKEN}/{paymentId}/{secret}`
— both secrets sit in the path, never the query string, because QPay appends its
own query parameters. The route is unauthenticated (QPay cannot present a JWT)
and rate limited to 120 requests/minute.

**A callback never carries payment state into the database.** It only tells us
which invoice to re-check; the status always comes from QPay's own
`/v2/payment/check` response. A replayed or forged callback therefore changes
nothing. The per-invoice secret is compared in constant time.

Because callbacks do get lost, a maintenance job re-checks pending invoices
every two minutes and expires the ones past `QPAY_INVOICE_TTL_MINUTES`;
`POST /api/payments/reconcile` runs the same sweep on demand.

---

## Prepaid wallets

A wallet holds a MNT balance that pays for charging automatically. Wallets are
addressed by a generic owner, so one implementation serves both front ends:

| Owner | Path | Who it is |
|---|---|---|
| `USER` | `/api/wallets/USER/<accountId>` | a driver account in the web app |
| `IDTAG` | `/api/wallets/IDTAG/<idTag>` | a bare RFID card, no account needed |

An idTag spends from its own `IDTAG` wallet unless it has been bound to another
one (`POST /api/wallets/USER/<id>/id-tags`), which is how every card a driver
owns ends up drawing on a single account balance. The driver app binds a tag
automatically when the driver links it.

### How money moves

```
top-up      POST /api/wallets/USER/42/topup  ──►  QPay invoice (purpose=WALLET_TOPUP)
                                                        │
                                   callback / check ────┘
                                                        ▼
                                        credit  +20,000₮   ledger: TOPUP
session end  StopTransaction ──► cost 4,300₮ ──► debit −4,300₮   ledger: CHARGE
```

Balances are only ever changed by `credit()` / `debit()` in
`services/wallet.service.ts`. Each writes an append-only `WalletEntry`, so the
balance is always reproducible by summing the ledger.

**Nothing credits a wallet without QPay confirming it.** A top-up invoice moves
no money at creation; the balance changes when `syncPayment` sees `PAID`, which
is the same path a callback and the reconciliation sweep both funnel through.

**Every movement is idempotent.** A ledger entry carries a unique
`idempotencyKey` — `payment:<paymentId>` for a top-up, `transaction:<id>` for a
session — so a replayed callback, a double-clicked poll and the two-minute sweep
all credit exactly once. A lost race is detected by the duplicate key and the
balance change is rolled back.

A refunded top-up is debited back out, so a driver cannot keep a balance QPay
has already returned to them.

### Debiting a session

`StopTransaction` debits `transaction.cost` from the wallet behind the tag. It
never throws: the charge point is waiting on that response, and a billing
problem must not leave a connector stuck. Failures are logged instead.

With `WALLET_ALLOW_NEGATIVE=true` (the default) a session that outran the
balance leaves the wallet negative — a debt the next top-up clears. Turning it
off would silently write off the shortfall instead. Sessions orphaned by a
charge point reboot are costed and debited the same way.

### Refusing to start on an empty wallet

With `WALLET_REQUIRE_BALANCE_TO_START=true`, `Authorize` returns `Blocked` for a
tag whose wallet is under `WALLET_MIN_START_BALANCE`. OCPP 1.6 has no "no
credit" status, and `Blocked` is the one chargers render as *contact your
operator* rather than *bad card*.

Two deliberate exceptions: the check is skipped when a tag is presented to
**stop** a session (a driver who ran out mid-charge must still be able to unplug),
and a wallet lookup that errors is logged and allowed through rather than
locking every driver out of the network.

**Roll wallets out before enabling this** — it stops every card that has no
wallet yet, which is why it defaults to `false`.

### QuickQR sub-merchants

QuickQR invoices are issued *for* a sub-merchant, so onboard one first and put
its id in `QPAY_QUICKQR_MERCHANT_ID` (or pass `quickQrMerchantId` per invoice):

```bash
curl https://eplug.mn/api/qpay/cities -H "Authorization: Bearer $JWT"
curl https://eplug.mn/api/qpay/cities/11000/districts -H "Authorization: Bearer $JWT"
curl -X POST https://eplug.mn/api/qpay/merchants/company \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d '{"register_number":"6691374","company_name":"ZEV TABS LLC","name":"ZEV Tabs",
       "mcc_code":"5552","city":"11000","district":"13000","address":"...",
       "phone":"99112210","email":"admin@zevtabs.mn"}'
```

### Payment statuses

`PENDING` → `PAID` (or `PARTIALLY_PAID` when QPay reports less than the invoice
amount), `CANCELED`, `EXPIRED`, `REFUNDED`, `FAILED` (the invoice could not be
created). Settling a payment writes the paid amount onto the linked
transaction's `cost` and emits `payment.paid` on the SSE stream.

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

### PM2

`ecosystem.config.cjs` is ready to use instead of systemd:

```bash
npm run build && pm2 start ecosystem.config.cjs --env production && pm2 save
```

Run `pm2 startup` once and execute the command it prints so PM2 comes back after
a reboot. Useful afterwards: `pm2 logs csms`, `pm2 restart csms`, `pm2 monit`.

**Run exactly one instance in fork mode** — the config already does. Charge point
WebSockets, the OCPP call queue and the SSE bus are in-process state, so a second
worker would see only some of the charge points and REST commands would be routed
to the wrong process. Use `instances: 1`, never `'max'`.

### TLS

TLS is terminated at nginx: keep `TLS_ENABLED=false`, set
`OCPP_SECURITY_PROFILE=2`, and let the Node process listen on plain HTTP on
`127.0.0.1:3000`.

The eplug.mn certificate (RapidSSL / DigiCert, `eplug.mn` + `www.eplug.mn`,
expires **2027-03-05**) ships as two files from the CA plus the private key you
generated with the CSR:

| File | What it is |
|---|---|
| `eplug.crt` | leaf certificate |
| `bundle_files.crt` | intermediate (RapidSSL TLS RSA CA G1) + root (DigiCert Global Root G2) |
| `eplug.mn.key` | **your** private key — never leaves the server, never committed |

Build the chain nginx wants and install everything in one step:

```bash
cat eplug.crt bundle_files.crt > fullchain.crt
```

```bash
sudo ./deploy/install-nginx-ubuntu.sh fullchain.crt eplug.mn.key bundle_files.crt
```

The script installs nginx, verifies the key matches the certificate, copies the
files to `/etc/nginx/ssl/eplug.mn/` (key `0600`), enables the site, opens the
firewall and reloads. Then check it end to end:

```bash
curl -sS https://eplug.mn/api/health
```

Node can terminate TLS itself instead — set `TLS_ENABLED=true` with
`TLS_CERT_PATH=/etc/nginx/ssl/eplug.mn/fullchain.crt` and the matching key.
For **security profile 3**, Node must terminate TLS so it can read the client
certificate; set `OCPP_SECURITY_PROFILE=3` and `TLS_CA_PATH` to the CA that
issued your charge point certificates.

---

## Configuration

See `.env.example` for the full list. The ones that matter most:

| Variable | Meaning |
|---|---|
| `PUBLIC_BASE_URL` | public origin the API is served at, e.g. `https://eplug.mn` (discovery/logs only) |
| `API_BASE_PATH` | path all REST routes are mounted under, default `/api` |
| `MONGODB_URI` | MongoDB connection string |
| `JWT_SECRET` | **must** be changed; ≥ 16 characters |
| `OCPP_SECURITY_PROFILE` | 1, 2 or 3 (see above) |
| `OCPP_ALLOW_ANONYMOUS` | `true` lets unknown charge points self-register without a password. Fine for commissioning, **turn it off in production** |
| `OCPP_REQUIRE_KNOWN_CHARGEPOINT` | reject any charge point not already in the database |
| `OCPP_CALL_TIMEOUT_MS` | how long a REST command waits for the charge point (returns HTTP 504 on timeout) |
| `OCPP_LOG_MESSAGES` | persist every OCPP frame; `OCPP_LOG_RETENTION_DAYS` sets the TTL |
| `QPAY_ENABLED` | master switch for `/api/payments` |
| `QPAY_USERNAME` / `QPAY_PASSWORD` | QPay HTTP Basic credentials, used by both APIs |
| `QPAY_DEFAULT_PROVIDER` | `quickqr` (quickqr.qpay.mn) or `merchant` (merchant.qpay.mn) |
| `QPAY_QUICKQR_TERMINAL_ID` | terminal id QPay issued; **required** for QuickQR |
| `QPAY_QUICKQR_MERCHANT_ID` | default sub-merchant invoices are issued for |
| `QPAY_CALLBACK_TOKEN` | random secret prefixed to the callback path |
| `QPAY_TOKEN_SECRET` | encrypts stored QPay tokens at rest; falls back to `JWT_SECRET` |
| `WALLET_ENABLED` | master switch for `/api/wallets`, session debiting and the Authorize pre-check |
| `WALLET_TOPUP_PRESETS` | one-tap amounts the driver app offers, e.g. `1000,3000,5000,10000,20000,50000,100000` |
| `WALLET_TOPUP_MIN` / `WALLET_TOPUP_MAX` | bounds on a freely typed top-up, in MNT |
| `WALLET_MIN_START_BALANCE` | balance required before a tag may start a session |
| `WALLET_ALLOW_NEGATIVE` | let an overrun session leave a debt instead of being written off |
| `WALLET_REQUIRE_BALANCE_TO_START` | refuse `Authorize` below the minimum balance; **off by default** |

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
    qpay/                  QPay transport: crypto, http, token manager, API clients
    payment.service.ts     invoice lifecycle, callback verification, reconciliation
    wallet.service.ts      prepaid balances, idempotent ledger, session debiting
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
