# ReadyOn Time-Off Microservice

NestJS + SQLite microservice that owns the time-off request lifecycle and keeps
balances consistent with an HCM "source of truth" (Workday/SAP-class). Built for
the AI Take-Home Exercise. The design rationale, challenges, alternatives, and
invariants live in [`TRD.md`](./TRD.md) — read that first if you want the *why*.
This README is the *how*: install, run, exercise, and verify in under five minutes.

## Deliverables map

| Brief requirement | Location |
|---|---|
| Technical Requirements Document | [`TRD.md`](./TRD.md) |
| Microservice source | [`apps/time-off-service/`](./apps/time-off-service/) |
| Mock HCM (real deployable NestJS app) | [`apps/mock-hcm/`](./apps/mock-hcm/) |
| Test suite (unit, integration, property, e2e, mutation) | [`apps/**/*.spec.ts`](./apps/), [`apps/time-off-service/test/`](./apps/time-off-service/test/) |
| Coverage report (proof of coverage) | `coverage/lcov-report/index.html` after `npm run test:cov` |
| Mutation report (regression-killing power) | `reports/mutation/mutation.html` after `npm run mutation` |
| CI definition | [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) |

## Prerequisites

- **Node ≥ 20.19.0** (set in `package.json` `engines`). On macOS: `nvm install 20`.
- **npm** (ships with Node). No Docker, Postgres, or other globals required.
- SQLite is **embedded** via `better-sqlite3` — no server to install.

## Quick start

```bash
npm install
npm run start:mock-hcm      # mock HCM on :3001
npm run start:service       # time-off service on :3000
```

Use two terminals (or `&` to background) so both servers run side-by-side. Logs
go to stdout. The service writes to `:memory:` in tests and to
`data/timeoff.sqlite` when run via `nest start` (override with `DB_PATH=...`).
Both paths are gitignored.

## API tour (curl walkthrough)

```bash
# 1. Seed HCM with a starting balance for (e1, l1).
curl -X POST localhost:3001/admin/balances -H 'content-type: application/json' \
  -d '{"employeeId":"e1","locationId":"l1","balanceDays":10}'

# 2. Pull the HCM corpus into the service projection.
curl -X POST localhost:3000/sync/batch

# 3. Submit a 3-day request. Idempotency-Key is required (D3).
curl -X POST localhost:3000/time-off-requests -H 'content-type: application/json' \
  -H 'Idempotency-Key: demo-1' \
  -d '{"employeeId":"e1","locationId":"l1","amountDays":3}'
# → 201 PENDING, response body includes the request id

# 4. Approve it — replace <id> with the id from step 3.
curl -X POST localhost:3000/time-off-requests/<id>/approve \
  -H 'content-type: application/json' -d '{"managerId":"m1"}'
# → 200 APPROVED. An outbox row is enqueued; the dispatcher fires every 2s.

# 5. After ~2s, the request transitions to SYNCED and HCM shows 7 days left.
curl localhost:3000/time-off-requests/<id>
curl 'localhost:3000/balances/e1/l1?verify=true'
# baselineMatches is false until you batch-sync — HCM owns accruals, we own holds.

# 6. Re-pull the baseline.
curl -X POST localhost:3000/sync/batch
curl 'localhost:3000/balances/e1/l1?verify=true'
# → baselineMatches: true

# Manager denial / employee cancel both release the hold:
curl -X POST localhost:3000/time-off-requests/<id>/deny \
  -H 'content-type: application/json' -d '{"managerId":"m1"}'
curl -X POST localhost:3000/time-off-requests/<id>/cancel

# Drift report — surfaces SYNC_FAILED requests and negative balances for
# manager action (TRD §7.2, §8 D5).
curl localhost:3000/admin/reconciliation/drift

# Liveness + HCM reachability.
curl -i localhost:3000/health
```

All errors use `application/problem+json` with enumerated `title` codes:
`INSUFFICIENT_BALANCE`, `INVALID_DIMENSIONS`, `INVALID_TRANSITION`,
`HCM_UNAVAILABLE`, `NOT_FOUND`, `VALIDATION_FAILED`. Full endpoint table in
[TRD §9](./TRD.md#9-api-specification).

## Mock HCM control plane

`apps/mock-hcm` is a **real NestJS app**, not an in-process stub — so e2e tests
exercise actual HTTP behavior (timeouts, connection errors, content-type
mismatches). Two control endpoints let tests and demos drive its behavior:

| Endpoint | Purpose |
|---|---|
| `POST /admin/balances` | Seed or mutate a balance. Body: `{employeeId, locationId, balanceDays}`. Use to simulate out-of-band changes (anniversary bonus, HR clawback). |
| `POST /chaos/mode` | Switch chaos mode. Body: `{mode: "<name>"}`. |

| Chaos mode | Behavior | Fences |
|---|---|---|
| `healthy` (default) | All requests behave normally. | The golden path. |
| `timeout` | Responses hang for `MOCK_HCM_TIMEOUT_MS` (default 10s; 2s in tests). | Client timeout + retry backoff (D2 / D4). |
| `error500` | Returns 500 on every endpoint. | Outbox retry, drift surfacing, `/health` 503. |
| `silent-failure` | `POST /deductions` returns 200 *without* applying. The "lying HCM". | D2 verification: a 2xx is never trusted on its own. |
| `reject-insufficient` | `POST /deductions` returns 422 `INSUFFICIENT_BALANCE`. | Honest HCM rejection path → `SYNC_FAILED`. |

```bash
curl -X POST localhost:3001/chaos/mode -H 'content-type: application/json' \
  -d '{"mode":"silent-failure"}'
# now approve a request — watch it stay APPROVED, retry, then SYNCED once you flip
# back to healthy. HCM's balance is never double-deducted.
```

## Test suite (the deliverable the brief grades you on)

| Layer | Command | What it fences |
|---|---|---|
| Unit + integration | `npm test` (or `npx jest`) | State machine edges, hold atomicity, idempotency (D3), outbox transitions, ledger arithmetic, input validation, distinct-key concurrency (D4) |
| Property-based | `npm run test:property` | I1 (ledger == projection), I2 (no service-initiated negatives), I3 (one hold + one confirm per request) under randomized op sequences via `fast-check` |
| Chaos e2e | `npm run test:e2e:chaos` | Real HTTP between service and mock-hcm: timeouts, 500s, silent failure, out-of-band changes mid-approval, `/health` fast-fail under timeout |
| Coverage | `npm run test:cov` | HTML at `coverage/lcov-report/index.html`. Jest config gates at **90% lines / 75% branches** (`package.json` `coverageThreshold`) |
| Mutation | `npm run mutation` | StrykerJS — HTML at `reports/mutation/mutation.html`. Mutates the service layer; the score is the regression fence's true strength |

Open the HTML reports locally:

```bash
open coverage/lcov-report/index.html        # macOS
open reports/mutation/mutation.html
# Linux: xdg-open ...
```

CI runs unit → integration → e2e → coverage gate on every push
(`.github/workflows/ci.yml`).

### What's specifically tested for the brief's hard cases

- **Out-of-band HCM updates** (anniversary bonus, yearly refresh): batch sync
  preserves in-flight holds — `chaos.e2e-spec.ts` "anniversary bonus during
  pending request", `reconciliation.spec.ts` "anniversary bonus (C1)",
  `balances.service.spec.ts` "bonus after a clawback recovers".
- **HCM that doesn't reject when it should**: silent-failure mode +
  read-after-write verification — `chaos.e2e-spec.ts` "the lying HCM".
- **HCM that rejects after we said yes locally** (clawback between approval
  and dispatch): `chaos.e2e-spec.ts` "out-of-band clawback".
- **Concurrent races**: same idempotency-key (D3) and distinct keys oversubscribing
  the same balance (D4) — `requests.service.spec.ts`.
- **`/health` under chaos**: returns 503 quickly (< 1.5s) when HCM hangs —
  `chaos.e2e-spec.ts` "GET /health under HCM timeout".
- **Invariant fencing**: I1/I2/I3 hold under random interleavings of
  submit/approve/deny/cancel/batch-sync — `test/property/invariants.spec.ts`.

## Project structure

```
apps/
  time-off-service/                  # the microservice
    src/
      requests/                      # request lifecycle (state machine + DTOs + service)
      balances/                      # projection: "what's available right now"
      ledger/                        # append-only audit + I1 anchor
      hcm-sync/                      # the only module that talks to HCM
        hcm-client.ts                #   HTTP client (4xx = decision, 5xx = unavailable)
        outbox-dispatcher.ts         #   retry + read-after-write verification (D2)
        reconciliation.service.ts    #   batch ingest + drift report
        schedulers.ts                #   dispatcher tick (2s) + nightly batch (02:00)
      common/                        # DbMutex (D4), problem+json filter, AppError
      entities/                      # 4 TypeORM entities (balance, request, ledger, outbox)
    test/
      integration/                   # SQLite + Nest module, no HTTP mocks
      property/                      # fast-check invariant suite
      e2e/                           # real HTTP between service and mock-hcm
      utils.ts                       # buildTestApp() + bootMockHcm()
  mock-hcm/                          # real deployable NestJS HCM stand-in with chaos modes
TRD.md                               # the engineering spec — read this for the design
stryker.config.json                  # mutation testing config
```

## Architecture in 90 seconds

Three ideas keep balances correct without trusting HCM blindly. Full reasoning
and alternatives are in [`TRD.md`](./TRD.md).

1. **Hold-then-confirm.** Submission places a *local* hold (read-validate-write
   inside one transaction, serialized by `DbMutex` → never oversubscribes).
   Approval enqueues a transactional outbox row. The dispatcher pushes the
   deduction to HCM, **then verifies it by re-reading via idempotency key**
   (TRD D2 — a 2xx response is never trusted on its own).
2. **Hold-aware batch merge.** When HCM's batch corpus arrives, it replaces
   `accrued_baseline` only; pending holds are re-applied on top. Anniversary
   bonuses raise the baseline; clawbacks can push `available` negative, which
   is journaled honestly and surfaced in the drift report rather than silently
   reconciled away (TRD §7.2).
3. **Append-only ledger as the anchor.** Every balance movement appends one
   row; `SUM(ledger.amount)` must equal the projection's `available`
   (**invariant I1**). The property-based test suite hammers this under random
   op sequences — it's the regression fence that catches bugs example-based
   tests miss.

## Assumptions & non-goals

- **Auth** is delegated to an upstream gateway. Endpoints take `employeeId` /
  `managerId` as inputs; this service does not enforce who is who.
- **Per employee × location balances**, single number of days — no leave
  types, carry-over rules, accrual policies, partial-day half-rates, etc.
- **SQLite single-writer** is mandated by the brief; the design's
  concurrency primitives (`DbMutex` + conditional UPDATE pattern) map directly
  to `SELECT … FOR UPDATE` / atomic UPDATE on Postgres without service changes
  (TRD §10, §12).
- **REST**, not GraphQL — REST is justified in TRD §10; lifecycle actions
  (`approve`/`deny`) map naturally to verbed sub-resources.

### Known limits (intentionally out of scope)

- **Dispatcher is in-process** (not BullMQ / SQS). Crash between SENT and
  VERIFIED is recovered on restart via the idempotency key. TRD §12.
- **List endpoints are unpaginated.** Fine at exercise scale; production would
  add cursor pagination.
- **No dedicated webhook for anniversary / yearly refresh.** The batch sync
  endpoint (`POST /sync/batch`) is the integration point for any out-of-band
  HCM change — manual, scheduled, or webhook-triggered by HCM. TRD §7.2.

## Troubleshooting

- **`Error: listen EADDRINUSE :::3000`** — something else is on the port.
  `lsof -i :3000` to find it, or `PORT=3010 npm run start:service`.
- **`Error: better-sqlite3 ... NODE_MODULE_VERSION mismatch`** — Node version
  changed since `npm install`. Rebuild: `npm rebuild better-sqlite3`.
- **`npm install` fails on `better-sqlite3`** — needs a working C++ toolchain.
  macOS: `xcode-select --install`. Linux: `build-essential` + `python3`.
- **Tests hang** — usually a runaway scheduler interval. The test harness
  shuts schedulers down between specs; if you've added a new test, ensure
  `await app.close()` is in the `afterEach`.
- **Mutation run is slow** — Stryker re-runs Jest per mutant. Expected ~3–5
  minutes locally. Use `npx stryker run --mutate apps/time-off-service/src/requests/**`
  to scope to one module while iterating.
