# ReadyOn Time-Off Microservice

Time-off request lifecycle with HCM synchronization. See [TRD.md](./TRD.md) for the
full technical requirements, architecture, trade-off analysis, and defensive design.

## Quick start

```bash
npm install
npm run start:mock-hcm     # mock HCM on :3001 (chaos modes: POST /chaos/mode)
npm run start:service      # service on :3000
```

Walkthrough:
```bash
# seed HCM and pull the corpus
curl -X POST localhost:3001/admin/balances -H 'content-type: application/json' \
  -d '{"employeeId":"e1","locationId":"l1","balanceDays":10}'
curl -X POST localhost:3000/sync/batch

# request 3 days
curl -X POST localhost:3000/time-off-requests -H 'content-type: application/json' \
  -H 'Idempotency-Key: demo-1' \
  -d '{"employeeId":"e1","locationId":"l1","amountDays":3}'

# approve it (use the id from the previous response)
curl -X POST localhost:3000/time-off-requests/<id>/approve \
  -H 'content-type: application/json' -d '{"managerId":"m1"}'

# watch it reach SYNCED (dispatcher runs every 2s)
curl localhost:3000/time-off-requests/<id>
curl 'localhost:3000/balances/e1/l1?verify=true'

# Note: right after the deduction, HCM's balance is 7 but the local accrued
# baseline is still 10 (HCM owns accruals; we refresh on batch sync), so
# baselineMatches is false — expected. Re-sync to refresh the baseline:
curl -X POST localhost:3000/sync/batch
curl 'localhost:3000/balances/e1/l1?verify=true'   # now baselineMatches: true
```

## Test suite (the point of this exercise)

| Layer | Command | What it fences |
|---|---|---|
| Unit + integration | `npx jest` | state machine edges, hold atomicity, idempotency, outbox |
| Property-based | `npm run test:property` | ledger==projection, no negatives, model agreement under random op sequences |
| Chaos e2e | `npm run test:e2e:chaos` | timeouts, 500s, silent failures, out-of-band changes — over real HTTP |
| Coverage | `npm run test:cov` | report in `coverage/` — 96.7% lines / 80.18% branches |
| Mutation | `npm run mutation` | StrykerJS score: 75.26% (209 killed, 80 timeout, 73 survived / 384 total) — proof the tests catch regressions |

CI runs all of the above on every push (`.github/workflows/ci.yml`).
