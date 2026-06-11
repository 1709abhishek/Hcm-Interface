# Time-Off Microservice — Design

> Status: APPROVED (all sections)
> Full technical detail lives in `TRD.md` at the repo root — that is the graded deliverable.
> Source: AI Take-Home Exercise (ReadyOn ↔ HCM time-off sync)

## Problem

ReadyOn is the employee-facing interface for time-off requests, but the HCM (Workday/SAP)
is the source of truth for balances. Balances change out-of-band (anniversary bonuses,
yearly refresh). HCM offers a realtime API and a batch corpus endpoint. HCM *may* return
errors on invalid/insufficient requests — but this is not guaranteed, so the service must
be defensive.

Constraints from the exercise: NestJS + SQLite, balances are per-employee per-location,
mock HCM endpoints required, graded on TRD quality and test rigor.

## Locked Decisions

| Decision | Choice | Why |
|---|---|---|
| API style | REST | Simpler review surface, fits resource/lifecycle model; GraphQL adds schema overhead with no benefit at this scope |
| HCM deduction timing | On manager approval | Employee submit places a local hold (instant feedback); HCM only mutated once the request is real |
| Architecture | Local balance projection + holds + idempotent HCM writes + batch reconciliation + **append-only ledger** | See alternatives below |
| HCM write delivery | **Transactional outbox** + read-after-write verification | Approval never blocked by HCM downtime; silent failures (200 OK, no effect) are caught by verification |
| Concurrency | Atomic conditional `UPDATE … WHERE available >= :amount` + idempotency keys | SQLite serializes writers; affected-rows check prevents double-spend; keys make retries safe |
| Reconciliation conflict policy | **Hold-aware merge**: HCM snapshot replaces accrued baseline, local holds re-applied on top, drift logged as `RECONCILIATION_ADJUSTMENT` | Blind overwrite destroys in-flight holds; flag-everything doesn't scale |
| TRD location | `TRD.md` at repo root | Graded deliverable, maximum visibility |

### Alternatives considered (to be expanded in TRD)

- **A: Pass-through proxy** over HCM realtime API — simplest, but no instant feedback, no defense against HCM being down or lying.
- **B without ledger** — same architecture, minimal schema, but loses the audit trail and the strongest test invariant.
- **C: Full event sourcing** — strongest audit story, heaviest to build/review; the ledger gives 80% of the value at 20% of the cost.

## Section 1 — Architecture & Data Model (APPROVED)

**Monorepo, two NestJS apps:**

- `apps/time-off-service` — the microservice (graded artifact)
- `apps/mock-hcm` — standalone mock HCM server with chaos modes (failure injection: timeouts, 500s, silent failures, out-of-band balance changes)

**Service modules:** `requests` (lifecycle state machine), `balances` (projection/read model), `ledger` (append-only audit), `hcm-sync` (HCM client + outbox dispatcher + batch reconciliation). Only `hcm-sync` talks to HCM.

**SQLite tables (TypeORM + better-sqlite3, WAL mode):**

| Table | Purpose |
|---|---|
| `balances` | Projection per (employee_id, location_id): `accrued_baseline` (HCM-owned), `pending_holds`, `taken`. `available = baseline − taken − holds` |
| `time_off_requests` | State machine: `PENDING → APPROVED → SYNCED`; `PENDING → DENIED/CANCELLED`; `APPROVED → SYNC_FAILED`. Unique `idempotency_key` |
| `ledger` | Append-only: `HOLD_PLACED`, `HOLD_RELEASED`, `DEDUCTION_CONFIRMED`, `ACCRUAL_SYNC`, `RECONCILIATION_ADJUSTMENT` — each with amount and `balance_after` |
| `outbox` | HCM writes: payload, status (`PENDING/SENT/VERIFIED/FAILED`), attempts, `next_retry_at`, idempotency key |

**Core invariants (the regression fence):** per (employee, location):
1. `SUM(ledger) == balances projection`
2. `available >= 0` always

**Happy path:** submit → atomic conditional hold → approve → outbox row in same transaction → dispatcher sends idempotent HCM deduct → verification GET → `SYNCED`, hold converted to `taken`.

## Section 2 — API, Sync & Defensive Logic, Errors (APPROVED)

**REST endpoints:**

| Endpoint | Behavior |
|---|---|
| `POST /time-off-requests` | `Idempotency-Key` header required. Atomic hold; `422 INSUFFICIENT_BALANCE` on failure. Duplicate key returns the original request |
| `POST /time-off-requests/:id/approve` / `/deny` / `/cancel` | Approve enqueues outbox; deny/cancel release the hold. Illegal transition → `409` |
| `GET /time-off-requests`, `GET /time-off-requests/:id` | List/detail with status filters |
| `GET /balances/:employeeId/:locationId` | Local projection + `lastSyncedAt`; `?verify=true` adds live HCM cross-check |
| `POST /sync/batch` | Ingest HCM batch corpus (also on cron) |
| `GET /admin/reconciliation/drift` | Drift report from `RECONCILIATION_ADJUSTMENT` entries |
| `GET /health` | Liveness + HCM reachability |

**Defensive posture:**
1. Never trust HCM to reject — local pre-validation before every mutation.
2. Never trust HCM to succeed — verification GET after every outbox write; an unverified 200 is retried, not trusted.
3. Retries safe via idempotency keys on both our API and HCM writes.
4. Out-of-band change causes HCM rejection of an approved deduct → request `SYNC_FAILED`, hold released, ledger records why.
5. Exponential backoff + jitter, capped attempts; failures surface in drift report.

**Errors:** `application/problem+json` envelope, enumerated codes: `INSUFFICIENT_BALANCE`, `INVALID_DIMENSIONS`, `DUPLICATE_REQUEST`, `INVALID_TRANSITION`, `HCM_UNAVAILABLE`.

## Section 3 — Testing Strategy & Repo Layout (APPROVED)

**Test pyramid — each layer fences a different regression class:**

1. **Unit (Jest)** — state machine transitions (every legal/illegal edge), balance math, reconciliation merge logic. Pure, no I/O.
2. **Integration (real SQLite, no DB mocks)** — atomic conditional hold under concurrent submits, idempotency-key dedup, outbox enqueue-in-same-transaction, ledger append.
3. **Property/invariant (fast-check)** — random interleavings of submit/approve/deny/cancel/batch-sync vs a reference model; assert `SUM(ledger) == projection`, `available >= 0`, no double-deduction after every step.
4. **E2E (supertest + real mock-hcm process)** — lifecycle happy paths plus chaos: HCM timeout, 500s, silent failure (200 OK without effect), out-of-band balance change mid-approval, batch reconciliation during pending holds.
5. **Mutation testing (StrykerJS)** on the service layer, score in README. **CI (GitHub Actions)**: lint → unit+integration → e2e → coverage gate; coverage report is the proof-of-coverage deliverable.

**Mock HCM:** in-memory store; `GET /balances/:emp/:loc`, `POST /deductions`, `GET /batch`; chaos endpoints (`POST /chaos/mode`, `POST /admin/balances`) for failure injection and out-of-band changes.

**Repo layout:**
```
TRD.md  README.md  .github/workflows/ci.yml
apps/time-off-service/src/{requests,balances,ledger,hcm-sync}
apps/time-off-service/test/{unit,integration,property,e2e}
apps/mock-hcm/src
docs/superpowers/specs/
```
