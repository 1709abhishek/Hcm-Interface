# Time-Off Microservice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the ReadyOn Time-Off Microservice per `TRD.md`: request lifecycle with local holds, append-only ledger, transactional outbox to HCM with verification, hold-aware batch reconciliation — fenced by unit, integration, property, chaos-e2e, and mutation tests.

**Architecture:** NestJS monorepo with two apps. `apps/time-off-service` holds four modules (`ledger`, `balances`, `requests`, `hcm-sync`); only `hcm-sync` performs HCM I/O. `apps/mock-hcm` is a real HTTP server with chaos modes used by e2e tests. SQLite via TypeORM + better-sqlite3 (single serialized connection — read-then-write inside a transaction is race-free; document this wherever relied upon).

**Tech Stack:** NestJS 11, TypeScript, TypeORM + better-sqlite3, @nestjs/schedule, Jest + supertest, fast-check, StrykerJS, GitHub Actions.

**Conventions for all tasks:**
- TDD: write the failing test, see it fail, implement, see it pass, commit.
- Run tests from repo root: `npx jest <path> --verbose`.
- Money-path code NEVER mutates `balances` without appending a `ledger` row in the same transaction.
- Ledger `amount` is the signed delta to `available` (I1: `SUM(ledger.amount) == available`).

---

## File Structure

```
TRD.md, README.md, .github/workflows/ci.yml, stryker.config.json
nest-cli.json, package.json, tsconfig.json
apps/
  time-off-service/
    src/
      main.ts
      app.module.ts
      common/
        app-error.ts                 # AppError(code, status, detail)
        problem-json.filter.ts       # application/problem+json envelope
      entities/                      # all four TypeORM entities
        balance.entity.ts
        time-off-request.entity.ts
        ledger-entry.entity.ts
        outbox-row.entity.ts
      ledger/
        ledger.module.ts
        ledger.service.ts            # append(em, entry), sumFor(e,l)
      balances/
        balances.module.ts
        balances.service.ts          # available(), placeHold/releaseHold/confirmDeduction, applyBatch
        balances.controller.ts       # GET /balances/:employeeId/:locationId
      requests/
        requests.module.ts
        state-machine.ts             # pure transition table
        requests.service.ts          # submit/approve/deny/cancel, markSynced/markSyncFailed
        requests.controller.ts
      hcm-sync/
        hcm-sync.module.ts
        hcm-client.ts                # fetch + timeout; getBalance, postDeduction, hasDeduction, getBatch
        outbox-dispatcher.ts         # processOnce(): send → verify → confirm/retry/fail
        reconciliation.service.ts    # runBatchSync()
        sync.controller.ts           # POST /sync/batch, GET /admin/reconciliation/drift, GET /health
    test/
      utils.ts                       # buildTestApp(), bootMockHcm()
      integration/*.spec.ts
      property/invariants.spec.ts
      e2e/chaos.e2e-spec.ts
  mock-hcm/
    src/
      main.ts
      mock-hcm.module.ts
      balance-store.service.ts       # in-memory store + chaos mode
      hcm.controller.ts              # balances/deductions/batch
      admin.controller.ts            # /admin/balances, /chaos/mode
```

Unit specs (`*.spec.ts`) live next to their source files (Nest convention).

---

### Task 1: Scaffold the monorepo

**Files:**
- Create: entire Nest workspace (CLI-generated), `apps/mock-hcm/*`
- Modify: `package.json` (scripts), `.gitignore`

- [ ] **Step 1: Generate the workspace and second app**

```bash
cd /Users/abhishekjain/Desktop/Hcm-Interface
npx @nestjs/cli@latest new time-off-service --directory . --skip-git --package-manager npm
npx @nestjs/cli generate app mock-hcm
```

The second command converts to monorepo layout: existing `src/` moves to `apps/time-off-service/src/`. Verify `nest-cli.json` lists both projects and `apps/time-off-service` + `apps/mock-hcm` exist.

- [ ] **Step 2: Install dependencies**

```bash
npm i @nestjs/typeorm typeorm better-sqlite3 @nestjs/schedule
npm i -D fast-check @stryker-mutator/core @stryker-mutator/jest-runner
```

- [ ] **Step 3: Add data dir to .gitignore and root scripts**

Append to `.gitignore`:
```
data/
*.sqlite
```

Add to root `package.json` scripts (keep CLI-generated ones):
```json
"start:service": "nest start time-off-service",
"start:mock-hcm": "nest start mock-hcm",
"test:cov": "jest --coverage",
"test:int": "jest apps/time-off-service/test/integration --runInBand",
"test:property": "jest apps/time-off-service/test/property --runInBand",
"test:e2e:chaos": "jest apps/time-off-service/test/e2e --runInBand",
"mutation": "stryker run"
```

Also ensure the root jest config (in `package.json`) has `"roots": ["<rootDir>/apps/"]` and `testRegex` matching both `.spec.ts` and `.e2e-spec.ts`:
```json
"testRegex": ".*\\.(e2e-)?spec\\.ts$"
```

- [ ] **Step 4: Verify the scaffold builds and default tests pass**

```bash
npm run build
npx jest --listTests
```
Expected: build succeeds; jest lists the two generated `app.controller.spec.ts` files.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold NestJS monorepo (time-off-service + mock-hcm)"
```

---

### Task 2: Mock HCM — balance store with chaos modes

**Files:**
- Create: `apps/mock-hcm/src/balance-store.service.ts`
- Test: `apps/mock-hcm/src/balance-store.service.spec.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/mock-hcm/src/balance-store.service.spec.ts
import { BalanceStoreService } from './balance-store.service';

describe('BalanceStoreService', () => {
  let store: BalanceStoreService;
  beforeEach(() => { store = new BalanceStoreService(); });

  it('sets and gets a balance per employee+location', () => {
    store.set('e1', 'l1', 10);
    expect(store.get('e1', 'l1')).toBe(10);
    expect(store.get('e1', 'l2')).toBeUndefined();
  });

  it('applies a deduction and records it by idempotency key', () => {
    store.set('e1', 'l1', 10);
    expect(store.applyDeduction('k1', 'e1', 'l1', 3)).toBe('applied');
    expect(store.get('e1', 'l1')).toBe(7);
    expect(store.hasDeduction('k1')).toBe(true);
  });

  it('is idempotent: same key applied twice deducts once', () => {
    store.set('e1', 'l1', 10);
    store.applyDeduction('k1', 'e1', 'l1', 3);
    expect(store.applyDeduction('k1', 'e1', 'l1', 3)).toBe('duplicate');
    expect(store.get('e1', 'l1')).toBe(7);
  });

  it('rejects insufficient balance and unknown dimensions', () => {
    store.set('e1', 'l1', 2);
    expect(store.applyDeduction('k2', 'e1', 'l1', 3)).toBe('insufficient');
    expect(store.applyDeduction('k3', 'eX', 'l1', 1)).toBe('unknown-dimensions');
    expect(store.get('e1', 'l1')).toBe(2);
    expect(store.hasDeduction('k2')).toBe(false);
  });

  it('lists the full corpus for the batch endpoint', () => {
    store.set('e1', 'l1', 10);
    store.set('e2', 'l1', 5);
    expect(store.all()).toEqual(expect.arrayContaining([
      { employeeId: 'e1', locationId: 'l1', balanceDays: 10 },
      { employeeId: 'e2', locationId: 'l1', balanceDays: 5 },
    ]));
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

```bash
npx jest apps/mock-hcm/src/balance-store.service.spec.ts --verbose
```
Expected: FAIL — cannot find module './balance-store.service'.

- [ ] **Step 3: Implement the store**

```typescript
// apps/mock-hcm/src/balance-store.service.ts
import { Injectable } from '@nestjs/common';

export interface HcmBalance { employeeId: string; locationId: string; balanceDays: number; }
export type ChaosMode = 'healthy' | 'timeout' | 'error500' | 'silent-failure' | 'reject-insufficient';
export type DeductionResult = 'applied' | 'duplicate' | 'insufficient' | 'unknown-dimensions';

@Injectable()
export class BalanceStoreService {
  chaosMode: ChaosMode = 'healthy';
  private balances = new Map<string, number>();
  private deductions = new Map<string, { employeeId: string; locationId: string; amountDays: number }>();

  private key(employeeId: string, locationId: string): string {
    return `${employeeId}:${locationId}`;
  }

  set(employeeId: string, locationId: string, balanceDays: number): void {
    this.balances.set(this.key(employeeId, locationId), balanceDays);
  }

  get(employeeId: string, locationId: string): number | undefined {
    return this.balances.get(this.key(employeeId, locationId));
  }

  all(): HcmBalance[] {
    return [...this.balances.entries()].map(([k, balanceDays]) => {
      const [employeeId, locationId] = k.split(':');
      return { employeeId, locationId, balanceDays };
    });
  }

  applyDeduction(idempotencyKey: string, employeeId: string, locationId: string, amountDays: number): DeductionResult {
    if (this.deductions.has(idempotencyKey)) return 'duplicate';
    const current = this.get(employeeId, locationId);
    if (current === undefined) return 'unknown-dimensions';
    if (current < amountDays) return 'insufficient';
    this.balances.set(this.key(employeeId, locationId), current - amountDays);
    this.deductions.set(idempotencyKey, { employeeId, locationId, amountDays });
    return 'applied';
  }

  hasDeduction(idempotencyKey: string): boolean {
    return this.deductions.has(idempotencyKey);
  }

  reset(): void {
    this.balances.clear();
    this.deductions.clear();
    this.chaosMode = 'healthy';
  }
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
npx jest apps/mock-hcm/src/balance-store.service.spec.ts --verbose
```
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/mock-hcm/src/balance-store.service.ts apps/mock-hcm/src/balance-store.service.spec.ts
git commit -m "feat(mock-hcm): in-memory balance store with idempotent deductions"
```

---

### Task 3: Mock HCM — HTTP endpoints (functional + chaos + admin)

**Files:**
- Create: `apps/mock-hcm/src/hcm.controller.ts`, `apps/mock-hcm/src/admin.controller.ts`
- Modify: `apps/mock-hcm/src/mock-hcm.module.ts` (register controllers + store; delete CLI-generated app.controller/app.service and their specs)
- Test: `apps/mock-hcm/src/hcm.controller.spec.ts` (supertest against a booted module)

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/mock-hcm/src/hcm.controller.spec.ts
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { MockHcmModule } from './mock-hcm.module';
import { BalanceStoreService } from './balance-store.service';

describe('mock-hcm HTTP API', () => {
  let app: INestApplication;
  let store: BalanceStoreService;

  beforeEach(async () => {
    const mod = await Test.createTestingModule({ imports: [MockHcmModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
    store = app.get(BalanceStoreService);
    store.set('e1', 'l1', 10);
  });
  afterEach(async () => { await app.close(); });

  it('GET /balances/:emp/:loc returns the balance, 404 when unknown', async () => {
    await request(app.getHttpServer()).get('/balances/e1/l1')
      .expect(200, { employeeId: 'e1', locationId: 'l1', balanceDays: 10 });
    await request(app.getHttpServer()).get('/balances/eX/l1').expect(404);
  });

  it('POST /deductions applies and is idempotent', async () => {
    const body = { idempotencyKey: 'k1', employeeId: 'e1', locationId: 'l1', amountDays: 3 };
    await request(app.getHttpServer()).post('/deductions').send(body).expect(201);
    await request(app.getHttpServer()).post('/deductions').send(body).expect(201);
    expect(store.get('e1', 'l1')).toBe(7);
  });

  it('POST /deductions rejects insufficient balance with 422', async () => {
    await request(app.getHttpServer()).post('/deductions')
      .send({ idempotencyKey: 'k2', employeeId: 'e1', locationId: 'l1', amountDays: 99 })
      .expect(422)
      .expect((res) => expect(res.body.code).toBe('INSUFFICIENT_BALANCE'));
  });

  it('GET /deductions/:key reports whether a deduction applied', async () => {
    await request(app.getHttpServer()).get('/deductions/k1').expect(404);
    await request(app.getHttpServer()).post('/deductions')
      .send({ idempotencyKey: 'k1', employeeId: 'e1', locationId: 'l1', amountDays: 1 }).expect(201);
    await request(app.getHttpServer()).get('/deductions/k1').expect(200);
  });

  it('GET /batch returns the whole corpus', async () => {
    store.set('e2', 'l1', 5);
    const res = await request(app.getHttpServer()).get('/batch').expect(200);
    expect(res.body.balances).toHaveLength(2);
  });

  it('chaos error500: deductions return 500 and do not apply', async () => {
    store.chaosMode = 'error500';
    await request(app.getHttpServer()).post('/deductions')
      .send({ idempotencyKey: 'k3', employeeId: 'e1', locationId: 'l1', amountDays: 1 }).expect(500);
    expect(store.get('e1', 'l1')).toBe(10);
  });

  it('chaos silent-failure: returns success but does NOT apply (the lying HCM)', async () => {
    store.chaosMode = 'silent-failure';
    await request(app.getHttpServer()).post('/deductions')
      .send({ idempotencyKey: 'k4', employeeId: 'e1', locationId: 'l1', amountDays: 1 }).expect(201);
    expect(store.get('e1', 'l1')).toBe(10);
    expect(store.hasDeduction('k4')).toBe(false);
  });

  it('chaos reject-insufficient: rejects everything with 422', async () => {
    store.chaosMode = 'reject-insufficient';
    await request(app.getHttpServer()).post('/deductions')
      .send({ idempotencyKey: 'k5', employeeId: 'e1', locationId: 'l1', amountDays: 1 }).expect(422);
  });

  it('admin endpoints seed balances and set chaos mode', async () => {
    await request(app.getHttpServer()).post('/admin/balances')
      .send({ employeeId: 'e9', locationId: 'l9', balanceDays: 4 }).expect(201);
    expect(store.get('e9', 'l9')).toBe(4);
    await request(app.getHttpServer()).post('/chaos/mode').send({ mode: 'timeout' }).expect(201);
    expect(store.chaosMode).toBe('timeout');
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

```bash
npx jest apps/mock-hcm/src/hcm.controller.spec.ts --verbose
```
Expected: FAIL — controllers/module exports missing.

- [ ] **Step 3: Implement controllers and module**

```typescript
// apps/mock-hcm/src/hcm.controller.ts
import { Body, Controller, Get, HttpException, NotFoundException, Param, Post } from '@nestjs/common';
import { BalanceStoreService } from './balance-store.service';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CHAOS_TIMEOUT_MS = Number(process.env.MOCK_HCM_TIMEOUT_MS ?? 10_000);

@Controller()
export class HcmController {
  constructor(private readonly store: BalanceStoreService) {}

  @Get('balances/:employeeId/:locationId')
  async getBalance(@Param('employeeId') employeeId: string, @Param('locationId') locationId: string) {
    if (this.store.chaosMode === 'timeout') await sleep(CHAOS_TIMEOUT_MS);
    if (this.store.chaosMode === 'error500') throw new HttpException('chaos', 500);
    const balanceDays = this.store.get(employeeId, locationId);
    if (balanceDays === undefined) throw new NotFoundException();
    return { employeeId, locationId, balanceDays };
  }

  @Post('deductions')
  async postDeduction(
    @Body() body: { idempotencyKey: string; employeeId: string; locationId: string; amountDays: number },
  ) {
    switch (this.store.chaosMode) {
      case 'timeout':
        await sleep(CHAOS_TIMEOUT_MS);
        break;
      case 'error500':
        throw new HttpException('chaos', 500);
      case 'silent-failure':
        return { status: 'ok' }; // lies: 2xx without applying
      case 'reject-insufficient':
        throw new HttpException({ code: 'INSUFFICIENT_BALANCE' }, 422);
    }
    const result = this.store.applyDeduction(body.idempotencyKey, body.employeeId, body.locationId, body.amountDays);
    if (result === 'insufficient') throw new HttpException({ code: 'INSUFFICIENT_BALANCE' }, 422);
    if (result === 'unknown-dimensions') throw new HttpException({ code: 'INVALID_DIMENSIONS' }, 422);
    return { status: 'ok' }; // applied or duplicate — idempotent success
  }

  @Get('deductions/:idempotencyKey')
  getDeduction(@Param('idempotencyKey') idempotencyKey: string) {
    if (!this.store.hasDeduction(idempotencyKey)) throw new NotFoundException();
    return { applied: true };
  }

  @Get('batch')
  getBatch() {
    return { balances: this.store.all() };
  }
}
```

```typescript
// apps/mock-hcm/src/admin.controller.ts
import { Body, Controller, Post } from '@nestjs/common';
import { BalanceStoreService, ChaosMode } from './balance-store.service';

@Controller()
export class AdminController {
  constructor(private readonly store: BalanceStoreService) {}

  @Post('admin/balances')
  seed(@Body() body: { employeeId: string; locationId: string; balanceDays: number }) {
    this.store.set(body.employeeId, body.locationId, body.balanceDays);
    return { status: 'ok' };
  }

  @Post('chaos/mode')
  setChaos(@Body() body: { mode: ChaosMode }) {
    this.store.chaosMode = body.mode;
    return { status: 'ok' };
  }
}
```

```typescript
// apps/mock-hcm/src/mock-hcm.module.ts
import { Module } from '@nestjs/common';
import { BalanceStoreService } from './balance-store.service';
import { HcmController } from './hcm.controller';
import { AdminController } from './admin.controller';

@Module({
  controllers: [HcmController, AdminController],
  providers: [BalanceStoreService],
  exports: [BalanceStoreService],
})
export class MockHcmModule {}
```

Update `apps/mock-hcm/src/main.ts` to use `MockHcmModule` and `process.env.MOCK_HCM_PORT ?? 3001`. Delete the CLI-generated `app.controller.ts`, `app.service.ts`, `mock-hcm.controller.ts`, `mock-hcm.service.ts` and their specs if present (names vary by CLI version — remove whatever boilerplate `nest g app` created, keep only the files above).

- [ ] **Step 4: Run tests — expect pass**

```bash
npx jest apps/mock-hcm --verbose
```
Expected: all mock-hcm suites pass.

- [ ] **Step 5: Commit**

```bash
git add apps/mock-hcm
git commit -m "feat(mock-hcm): HTTP API with chaos modes and admin control plane"
```

---

### Task 4: Entities, AppError, problem+json filter, test utils

**Files:**
- Create: `apps/time-off-service/src/entities/{balance,time-off-request,ledger-entry,outbox-row}.entity.ts`
- Create: `apps/time-off-service/src/common/app-error.ts`, `apps/time-off-service/src/common/problem-json.filter.ts`
- Create: `apps/time-off-service/test/utils.ts`
- Test: `apps/time-off-service/test/integration/schema.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/time-off-service/test/integration/schema.spec.ts
import { createTestDataSource } from '../utils';

describe('schema', () => {
  it('synchronizes all four entities into in-memory SQLite', async () => {
    const ds = await createTestDataSource();
    const tables = await ds.query(`SELECT name FROM sqlite_master WHERE type='table'`);
    const names = tables.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(['balances', 'time_off_requests', 'ledger', 'outbox']));
    await ds.destroy();
  });
});
```

- [ ] **Step 2: Run test — expect failure**

```bash
npx jest apps/time-off-service/test/integration/schema.spec.ts --verbose
```
Expected: FAIL — `../utils` not found.

- [ ] **Step 3: Implement entities, error types, filter, utils**

```typescript
// apps/time-off-service/src/entities/balance.entity.ts
import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('balances')
export class Balance {
  @PrimaryColumn({ name: 'employee_id', type: 'text' }) employeeId: string;
  @PrimaryColumn({ name: 'location_id', type: 'text' }) locationId: string;
  @Column({ name: 'accrued_baseline', type: 'real', default: 0 }) accruedBaseline: number;
  @Column({ name: 'pending_holds', type: 'real', default: 0 }) pendingHolds: number;
  @Column({ type: 'real', default: 0 }) taken: number;
  @Column({ name: 'last_synced_at', type: 'text', nullable: true }) lastSyncedAt: string | null;
}

export function available(b: Balance): number {
  return b.accruedBaseline - b.taken - b.pendingHolds;
}
```

```typescript
// apps/time-off-service/src/entities/time-off-request.entity.ts
import { Column, Entity, PrimaryColumn } from 'typeorm';

export type RequestStatus = 'PENDING' | 'APPROVED' | 'DENIED' | 'CANCELLED' | 'SYNCED' | 'SYNC_FAILED';

@Entity('time_off_requests')
export class TimeOffRequest {
  @PrimaryColumn({ type: 'text' }) id: string;
  @Column({ name: 'employee_id', type: 'text' }) employeeId: string;
  @Column({ name: 'location_id', type: 'text' }) locationId: string;
  @Column({ name: 'amount_days', type: 'real' }) amountDays: number;
  @Column({ type: 'text' }) status: RequestStatus;
  @Column({ name: 'idempotency_key', type: 'text', unique: true }) idempotencyKey: string;
  @Column({ name: 'manager_id', type: 'text', nullable: true }) managerId: string | null;
  @Column({ name: 'failure_reason', type: 'text', nullable: true }) failureReason: string | null;
  @Column({ name: 'created_at', type: 'text' }) createdAt: string;
  @Column({ name: 'updated_at', type: 'text' }) updatedAt: string;
}
```

```typescript
// apps/time-off-service/src/entities/ledger-entry.entity.ts
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type LedgerEntryType =
  | 'HOLD_PLACED' | 'HOLD_RELEASED' | 'DEDUCTION_CONFIRMED'
  | 'ACCRUAL_SYNC' | 'RECONCILIATION_ADJUSTMENT';

@Entity('ledger')
export class LedgerEntry {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'employee_id', type: 'text' }) employeeId: string;
  @Column({ name: 'location_id', type: 'text' }) locationId: string;
  @Column({ name: 'entry_type', type: 'text' }) entryType: LedgerEntryType;
  @Column({ type: 'real' }) amount: number;            // signed delta to `available`
  @Column({ name: 'balance_after', type: 'real' }) balanceAfter: number;
  @Column({ name: 'request_id', type: 'text', nullable: true }) requestId: string | null;
  @Column({ type: 'text', nullable: true }) detail: string | null;
  @Column({ name: 'created_at', type: 'text' }) createdAt: string;
}
```

```typescript
// apps/time-off-service/src/entities/outbox-row.entity.ts
import { Column, Entity, PrimaryColumn } from 'typeorm';

export type OutboxStatus = 'PENDING' | 'SENT' | 'VERIFIED' | 'FAILED';

@Entity('outbox')
export class OutboxRow {
  @PrimaryColumn({ type: 'text' }) id: string;
  @Column({ name: 'request_id', type: 'text' }) requestId: string;
  @Column({ type: 'text' }) operation: 'DEDUCT';
  @Column({ type: 'text' }) payload: string;           // JSON: {employeeId, locationId, amountDays}
  @Column({ name: 'idempotency_key', type: 'text', unique: true }) idempotencyKey: string;
  @Column({ type: 'text' }) status: OutboxStatus;
  @Column({ type: 'integer', default: 0 }) attempts: number;
  @Column({ name: 'next_retry_at', type: 'text', nullable: true }) nextRetryAt: string | null;
  @Column({ name: 'last_error', type: 'text', nullable: true }) lastError: string | null;
  @Column({ name: 'created_at', type: 'text' }) createdAt: string;
}
```

```typescript
// apps/time-off-service/src/common/app-error.ts
export type ErrorCode =
  | 'INSUFFICIENT_BALANCE' | 'INVALID_DIMENSIONS' | 'DUPLICATE_REQUEST'
  | 'INVALID_TRANSITION' | 'HCM_UNAVAILABLE' | 'NOT_FOUND' | 'VALIDATION_FAILED';

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly status: number,
    public readonly detail?: string,
  ) {
    super(detail ?? code);
  }
}
```

```typescript
// apps/time-off-service/src/common/problem-json.filter.ts
import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { Response } from 'express';
import { AppError } from './app-error';

@Catch()
export class ProblemJsonFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    let status = 500;
    let title = 'INTERNAL_ERROR';
    let detail: string | undefined;
    if (exception instanceof AppError) {
      status = exception.status;
      title = exception.code;
      detail = exception.detail;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      title = exception.message;
    }
    res.status(status)
      .type('application/problem+json')
      .json({ type: 'about:blank', title, status, ...(detail ? { detail } : {}) });
  }
}
```

```typescript
// apps/time-off-service/test/utils.ts
import { DataSource } from 'typeorm';
import { Balance } from '../src/entities/balance.entity';
import { TimeOffRequest } from '../src/entities/time-off-request.entity';
import { LedgerEntry } from '../src/entities/ledger-entry.entity';
import { OutboxRow } from '../src/entities/outbox-row.entity';

export const ALL_ENTITIES = [Balance, TimeOffRequest, LedgerEntry, OutboxRow];

export async function createTestDataSource(): Promise<DataSource> {
  const ds = new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    entities: ALL_ENTITIES,
    synchronize: true,
  });
  await ds.initialize();
  return ds;
}

export const nowIso = () => new Date().toISOString();
```

- [ ] **Step 4: Run test — expect pass**

```bash
npx jest apps/time-off-service/test/integration/schema.spec.ts --verbose
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/time-off-service/src/entities apps/time-off-service/src/common apps/time-off-service/test
git commit -m "feat(service): entities, AppError, problem+json filter, test utils"
```

---

### Task 5: Ledger module

**Files:**
- Create: `apps/time-off-service/src/ledger/ledger.service.ts`, `apps/time-off-service/src/ledger/ledger.module.ts`
- Test: `apps/time-off-service/src/ledger/ledger.service.spec.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/time-off-service/src/ledger/ledger.service.spec.ts
import { DataSource } from 'typeorm';
import { createTestDataSource } from '../../test/utils';
import { LedgerService } from './ledger.service';

describe('LedgerService', () => {
  let ds: DataSource;
  let ledger: LedgerService;

  beforeEach(async () => {
    ds = await createTestDataSource();
    ledger = new LedgerService();
  });
  afterEach(async () => { await ds.destroy(); });

  it('appends entries and sums the signed amounts per employee+location', async () => {
    await ds.transaction(async (em) => {
      await ledger.append(em, { employeeId: 'e1', locationId: 'l1', entryType: 'ACCRUAL_SYNC', amount: 10, balanceAfter: 10, requestId: null, detail: null });
      await ledger.append(em, { employeeId: 'e1', locationId: 'l1', entryType: 'HOLD_PLACED', amount: -3, balanceAfter: 7, requestId: 'r1', detail: null });
      await ledger.append(em, { employeeId: 'e2', locationId: 'l1', entryType: 'ACCRUAL_SYNC', amount: 5, balanceAfter: 5, requestId: null, detail: null });
    });
    expect(await ledger.sumFor(ds.manager, 'e1', 'l1')).toBe(7);
    expect(await ledger.sumFor(ds.manager, 'e2', 'l1')).toBe(5);
    expect(await ledger.sumFor(ds.manager, 'eX', 'l1')).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

```bash
npx jest apps/time-off-service/src/ledger --verbose
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// apps/time-off-service/src/ledger/ledger.service.ts
import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { LedgerEntry, LedgerEntryType } from '../entities/ledger-entry.entity';

export interface LedgerInput {
  employeeId: string;
  locationId: string;
  entryType: LedgerEntryType;
  amount: number;
  balanceAfter: number;
  requestId: string | null;
  detail: string | null;
}

@Injectable()
export class LedgerService {
  /** Must be called inside the same transaction as the balance mutation it records. */
  async append(em: EntityManager, input: LedgerInput): Promise<void> {
    await em.insert(LedgerEntry, { ...input, createdAt: new Date().toISOString() });
  }

  async sumFor(em: EntityManager, employeeId: string, locationId: string): Promise<number> {
    const row = await em
      .createQueryBuilder(LedgerEntry, 'l')
      .select('COALESCE(SUM(l.amount), 0)', 'total')
      .where('l.employee_id = :employeeId AND l.location_id = :locationId', { employeeId, locationId })
      .getRawOne<{ total: number }>();
    return Number(row?.total ?? 0);
  }
}
```

```typescript
// apps/time-off-service/src/ledger/ledger.module.ts
import { Module } from '@nestjs/common';
import { LedgerService } from './ledger.service';

@Module({ providers: [LedgerService], exports: [LedgerService] })
export class LedgerModule {}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
npx jest apps/time-off-service/src/ledger --verbose
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/time-off-service/src/ledger
git commit -m "feat(service): append-only ledger with per-balance sum"
```

---

### Task 6: Balances module — holds, deduction confirmation, batch merge

The heart of balance integrity. Every method mutates the projection AND appends the matching ledger entry in one transaction. Race-safety note: better-sqlite3 gives TypeORM a single synchronous connection, so check-then-write inside `dataSource.transaction` cannot interleave with another writer.

**Files:**
- Create: `apps/time-off-service/src/balances/balances.service.ts`, `apps/time-off-service/src/balances/balances.module.ts`
- Test: `apps/time-off-service/src/balances/balances.service.spec.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/time-off-service/src/balances/balances.service.spec.ts
import { DataSource } from 'typeorm';
import { createTestDataSource } from '../../test/utils';
import { BalancesService } from './balances.service';
import { LedgerService } from '../ledger/ledger.service';
import { AppError } from '../common/app-error';
import { Balance, available } from '../entities/balance.entity';

describe('BalancesService', () => {
  let ds: DataSource;
  let ledger: LedgerService;
  let svc: BalancesService;

  beforeEach(async () => {
    ds = await createTestDataSource();
    ledger = new LedgerService();
    svc = new BalancesService(ds, ledger);
    await svc.applyBatch([{ employeeId: 'e1', locationId: 'l1', balanceDays: 10 }]);
  });
  afterEach(async () => { await ds.destroy(); });

  const get = () => ds.manager.findOneByOrFail(Balance, { employeeId: 'e1', locationId: 'l1' });

  it('applyBatch creates the projection and an ACCRUAL_SYNC ledger entry (I1 holds)', async () => {
    const b = await get();
    expect(available(b)).toBe(10);
    expect(await ledger.sumFor(ds.manager, 'e1', 'l1')).toBe(10);
  });

  it('placeHold reduces available and appends HOLD_PLACED', async () => {
    await svc.placeHold('e1', 'l1', 3, 'r1');
    const b = await get();
    expect(b.pendingHolds).toBe(3);
    expect(available(b)).toBe(7);
    expect(await ledger.sumFor(ds.manager, 'e1', 'l1')).toBe(7);
  });

  it('placeHold rejects insufficient balance (D1) without mutating anything', async () => {
    await expect(svc.placeHold('e1', 'l1', 11, 'r1')).rejects.toMatchObject(
      new AppError('INSUFFICIENT_BALANCE', 422),
    );
    expect(available(await get())).toBe(10);
    expect(await ledger.sumFor(ds.manager, 'e1', 'l1')).toBe(10);
  });

  it('placeHold rejects unknown dimensions (D1)', async () => {
    await expect(svc.placeHold('eX', 'lX', 1, 'r1')).rejects.toMatchObject(
      new AppError('INVALID_DIMENSIONS', 422),
    );
  });

  it('concurrent holds cannot oversubscribe (D4)', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => svc.placeHold('e1', 'l1', 3, `r${i}`)),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
    expect(fulfilled).toBe(3); // 3 × 3 = 9 ≤ 10; a 4th would need 12
    expect(available(await get())).toBe(1);
    expect(await ledger.sumFor(ds.manager, 'e1', 'l1')).toBe(1);
  });

  it('releaseHold restores available and appends HOLD_RELEASED', async () => {
    await svc.placeHold('e1', 'l1', 3, 'r1');
    await svc.releaseHold('e1', 'l1', 3, 'r1');
    const b = await get();
    expect(b.pendingHolds).toBe(0);
    expect(available(b)).toBe(10);
    expect(await ledger.sumFor(ds.manager, 'e1', 'l1')).toBe(10);
  });

  it('confirmDeduction converts hold to taken; available unchanged; DEDUCTION_CONFIRMED appended', async () => {
    await svc.placeHold('e1', 'l1', 3, 'r1');
    await svc.confirmDeduction('e1', 'l1', 3, 'r1');
    const b = await get();
    expect(b.pendingHolds).toBe(0);
    expect(b.taken).toBe(3);
    expect(available(b)).toBe(7);
    expect(await ledger.sumFor(ds.manager, 'e1', 'l1')).toBe(7);
  });

  it('applyBatch replaces baseline but preserves pending holds (hold-aware merge, C1)', async () => {
    await svc.placeHold('e1', 'l1', 3, 'r1');
    await svc.applyBatch([{ employeeId: 'e1', locationId: 'l1', balanceDays: 15 }]); // anniversary bonus
    const b = await get();
    expect(b.accruedBaseline).toBe(15);
    expect(b.pendingHolds).toBe(3);
    expect(available(b)).toBe(12);
    expect(await ledger.sumFor(ds.manager, 'e1', 'l1')).toBe(12);
  });

  it('applyBatch clawback below holds goes honestly negative and reports drift', async () => {
    await svc.placeHold('e1', 'l1', 8, 'r1');
    const summary = await svc.applyBatch([{ employeeId: 'e1', locationId: 'l1', balanceDays: 5 }]);
    const b = await get();
    expect(available(b)).toBe(-3);
    expect(summary.negative).toEqual([{ employeeId: 'e1', locationId: 'l1', available: -3 }]);
    expect(await ledger.sumFor(ds.manager, 'e1', 'l1')).toBe(-3); // I1 still holds
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

```bash
npx jest apps/time-off-service/src/balances --verbose
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// apps/time-off-service/src/balances/balances.service.ts
import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { Balance, available } from '../entities/balance.entity';
import { LedgerService } from '../ledger/ledger.service';
import { AppError } from '../common/app-error';

export interface BatchEntry { employeeId: string; locationId: string; balanceDays: number; }
export interface BatchSummary {
  updated: number;
  created: number;
  negative: { employeeId: string; locationId: string; available: number }[];
}

@Injectable()
export class BalancesService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly ledger: LedgerService,
  ) {}

  async getBalance(employeeId: string, locationId: string): Promise<Balance> {
    const b = await this.dataSource.manager.findOneBy(Balance, { employeeId, locationId });
    if (!b) throw new AppError('NOT_FOUND', 404);
    return b;
  }

  /** D1 + D4: validate locally, mutate + ledger in one TX (race-free: single serialized SQLite writer). */
  async placeHold(employeeId: string, locationId: string, amountDays: number, requestId: string): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      const b = await em.findOneBy(Balance, { employeeId, locationId });
      if (!b) throw new AppError('INVALID_DIMENSIONS', 422, 'unknown employee/location balance');
      if (available(b) < amountDays) throw new AppError('INSUFFICIENT_BALANCE', 422);
      b.pendingHolds += amountDays;
      await em.save(b);
      await this.ledger.append(em, {
        employeeId, locationId, entryType: 'HOLD_PLACED',
        amount: -amountDays, balanceAfter: available(b), requestId, detail: null,
      });
    });
  }

  async releaseHold(employeeId: string, locationId: string, amountDays: number, requestId: string): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      const b = await em.findOneByOrFail(Balance, { employeeId, locationId });
      b.pendingHolds -= amountDays;
      await em.save(b);
      await this.ledger.append(em, {
        employeeId, locationId, entryType: 'HOLD_RELEASED',
        amount: amountDays, balanceAfter: available(b), requestId, detail: null,
      });
    });
  }

  /** Hold → taken. Net delta to available is 0; the entry is the audit record of the confirmed deduction. */
  async confirmDeduction(employeeId: string, locationId: string, amountDays: number, requestId: string): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      const b = await em.findOneByOrFail(Balance, { employeeId, locationId });
      b.pendingHolds -= amountDays;
      b.taken += amountDays;
      await em.save(b);
      await this.ledger.append(em, {
        employeeId, locationId, entryType: 'DEDUCTION_CONFIRMED',
        amount: 0, balanceAfter: available(b), requestId,
        detail: JSON.stringify({ amountDays }),
      });
    });
  }

  /** Hold-aware merge (TRD §7.2): HCM owns the baseline, we own holds/taken. */
  async applyBatch(entries: BatchEntry[]): Promise<BatchSummary> {
    const summary: BatchSummary = { updated: 0, created: 0, negative: [] };
    for (const entry of entries) {
      await this.dataSource.transaction(async (em) => {
        let b = await em.findOneBy(Balance, { employeeId: entry.employeeId, locationId: entry.locationId });
        if (!b) {
          b = em.create(Balance, {
            employeeId: entry.employeeId, locationId: entry.locationId,
            accruedBaseline: 0, pendingHolds: 0, taken: 0, lastSyncedAt: null,
          });
          summary.created += 1;
        } else {
          summary.updated += 1;
        }
        const delta = entry.balanceDays - b.accruedBaseline;
        b.accruedBaseline = entry.balanceDays;
        b.lastSyncedAt = new Date().toISOString();
        await em.save(b);
        if (delta !== 0) {
          await this.ledger.append(em, {
            employeeId: b.employeeId, locationId: b.locationId, entryType: 'ACCRUAL_SYNC',
            amount: delta, balanceAfter: available(b), requestId: null,
            detail: JSON.stringify({ newBaseline: entry.balanceDays }),
          });
        }
        if (available(b) < 0) {
          summary.negative.push({ employeeId: b.employeeId, locationId: b.locationId, available: available(b) });
        }
        // Defensive (TRD §7.2 step 3): if ledger and projection ever disagree, record the
        // discrepancy as RECONCILIATION_ADJUSTMENT so I1 is restored and the drift is visible.
        const drift = available(b) - (await this.ledger.sumFor(em, b.employeeId, b.locationId));
        if (drift !== 0) {
          await this.ledger.append(em, {
            employeeId: b.employeeId, locationId: b.locationId, entryType: 'RECONCILIATION_ADJUSTMENT',
            amount: drift, balanceAfter: available(b), requestId: null,
            detail: JSON.stringify({ reason: 'unexplained drift during batch sync' }),
          });
        }
      });
    }
    return summary;
  }

  /** Drift check for I1; used by reconciliation and the property suite. */
  async ledgerDrift(em: EntityManager, employeeId: string, locationId: string): Promise<number> {
    const b = await em.findOneByOrFail(Balance, { employeeId, locationId });
    const sum = await this.ledger.sumFor(em, employeeId, locationId);
    return available(b) - sum;
  }
}
```

```typescript
// apps/time-off-service/src/balances/balances.module.ts
import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { BalancesService } from './balances.service';

@Module({ imports: [LedgerModule], providers: [BalancesService], exports: [BalancesService] })
export class BalancesModule {}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
npx jest apps/time-off-service/src/balances --verbose
```
Expected: 9 passed (including the concurrency test).

- [ ] **Step 5: Commit**

```bash
git add apps/time-off-service/src/balances
git commit -m "feat(service): balance projection with holds, ledger coupling, hold-aware batch merge"
```

---

### Task 7: Request state machine (pure)

**Files:**
- Create: `apps/time-off-service/src/requests/state-machine.ts`
- Test: `apps/time-off-service/src/requests/state-machine.spec.ts`

- [ ] **Step 1: Write the failing tests — every legal AND illegal edge**

```typescript
// apps/time-off-service/src/requests/state-machine.spec.ts
import { nextStatus, RequestAction } from './state-machine';
import { RequestStatus } from '../entities/time-off-request.entity';
import { AppError } from '../common/app-error';

const LEGAL: [RequestStatus, RequestAction, RequestStatus][] = [
  ['PENDING', 'approve', 'APPROVED'],
  ['PENDING', 'deny', 'DENIED'],
  ['PENDING', 'cancel', 'CANCELLED'],
  ['APPROVED', 'syncSucceed', 'SYNCED'],
  ['APPROVED', 'syncFail', 'SYNC_FAILED'],
];

const ALL_STATUSES: RequestStatus[] = ['PENDING', 'APPROVED', 'DENIED', 'CANCELLED', 'SYNCED', 'SYNC_FAILED'];
const ALL_ACTIONS: RequestAction[] = ['approve', 'deny', 'cancel', 'syncSucceed', 'syncFail'];

describe('state machine', () => {
  it.each(LEGAL)('%s --%s--> %s', (from, action, to) => {
    expect(nextStatus(from, action)).toBe(to);
  });

  it('rejects every transition not in the legal table with INVALID_TRANSITION', () => {
    const legalSet = new Set(LEGAL.map(([f, a]) => `${f}:${a}`));
    for (const from of ALL_STATUSES) {
      for (const action of ALL_ACTIONS) {
        if (legalSet.has(`${from}:${action}`)) continue;
        expect(() => nextStatus(from, action)).toThrow(AppError);
        try { nextStatus(from, action); } catch (e) {
          expect((e as AppError).code).toBe('INVALID_TRANSITION');
          expect((e as AppError).status).toBe(409);
        }
      }
    }
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

```bash
npx jest apps/time-off-service/src/requests/state-machine.spec.ts --verbose
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// apps/time-off-service/src/requests/state-machine.ts
import { RequestStatus } from '../entities/time-off-request.entity';
import { AppError } from '../common/app-error';

export type RequestAction = 'approve' | 'deny' | 'cancel' | 'syncSucceed' | 'syncFail';

const TRANSITIONS: Partial<Record<RequestStatus, Partial<Record<RequestAction, RequestStatus>>>> = {
  PENDING: { approve: 'APPROVED', deny: 'DENIED', cancel: 'CANCELLED' },
  APPROVED: { syncSucceed: 'SYNCED', syncFail: 'SYNC_FAILED' },
};

export function nextStatus(from: RequestStatus, action: RequestAction): RequestStatus {
  const to = TRANSITIONS[from]?.[action];
  if (!to) throw new AppError('INVALID_TRANSITION', 409, `cannot ${action} a ${from} request`);
  return to;
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
npx jest apps/time-off-service/src/requests/state-machine.spec.ts --verbose
```
Expected: PASS (legal table + exhaustive illegal sweep).

- [ ] **Step 5: Commit**

```bash
git add apps/time-off-service/src/requests
git commit -m "feat(service): request lifecycle state machine with exhaustive edge tests"
```

---

### Task 8: RequestsService — submit/approve/deny/cancel with idempotency and outbox

**Files:**
- Create: `apps/time-off-service/src/requests/requests.service.ts`, `apps/time-off-service/src/requests/requests.module.ts`
- Test: `apps/time-off-service/src/requests/requests.service.spec.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/time-off-service/src/requests/requests.service.spec.ts
import { DataSource } from 'typeorm';
import { createTestDataSource } from '../../test/utils';
import { RequestsService } from './requests.service';
import { BalancesService } from '../balances/balances.service';
import { LedgerService } from '../ledger/ledger.service';
import { Balance, available } from '../entities/balance.entity';
import { OutboxRow } from '../entities/outbox-row.entity';
import { AppError } from '../common/app-error';

describe('RequestsService', () => {
  let ds: DataSource;
  let balances: BalancesService;
  let svc: RequestsService;

  beforeEach(async () => {
    ds = await createTestDataSource();
    balances = new BalancesService(ds, new LedgerService());
    svc = new RequestsService(ds, balances);
    await balances.applyBatch([{ employeeId: 'e1', locationId: 'l1', balanceDays: 10 }]);
  });
  afterEach(async () => { await ds.destroy(); });

  const submit = (key = 'key-1', amountDays = 3) =>
    svc.submit({ employeeId: 'e1', locationId: 'l1', amountDays }, key);
  const bal = () => ds.manager.findOneByOrFail(Balance, { employeeId: 'e1', locationId: 'l1' });

  it('submit creates PENDING and places the hold (instant feedback)', async () => {
    const req = await submit();
    expect(req.status).toBe('PENDING');
    expect(available(await bal())).toBe(7);
  });

  it('submit with the same Idempotency-Key returns the original — no second hold (D3)', async () => {
    const first = await submit();
    const second = await submit();
    expect(second.id).toBe(first.id);
    expect(available(await bal())).toBe(7);
  });

  it('submit rejects insufficient balance; nothing persisted', async () => {
    await expect(submit('key-big', 11)).rejects.toMatchObject(new AppError('INSUFFICIENT_BALANCE', 422));
    expect(await svc.findByIdempotencyKey('key-big')).toBeNull();
    expect(available(await bal())).toBe(10);
  });

  it('approve transitions to APPROVED and enqueues exactly one outbox row atomically', async () => {
    const req = await submit();
    await svc.approve(req.id, 'mgr-1');
    const updated = await svc.getById(req.id);
    expect(updated.status).toBe('APPROVED');
    expect(updated.managerId).toBe('mgr-1');
    const rows = await ds.manager.findBy(OutboxRow, { requestId: req.id });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('PENDING');
    expect(rows[0].idempotencyKey).toBe(`deduct-${req.id}`);
    expect(JSON.parse(rows[0].payload)).toEqual({ employeeId: 'e1', locationId: 'l1', amountDays: 3 });
  });

  it('deny and cancel release the hold', async () => {
    const r1 = await submit('k1');
    await svc.deny(r1.id, 'mgr-1');
    expect(available(await bal())).toBe(10);

    const r2 = await submit('k2');
    await svc.cancel(r2.id);
    expect(available(await bal())).toBe(10);
  });

  it('illegal transitions surface INVALID_TRANSITION (409)', async () => {
    const req = await submit();
    await svc.approve(req.id, 'mgr-1');
    await expect(svc.cancel(req.id)).rejects.toMatchObject(new AppError('INVALID_TRANSITION', 409));
    await expect(svc.approve(req.id, 'mgr-1')).rejects.toMatchObject(new AppError('INVALID_TRANSITION', 409));
  });

  it('markSynced confirms the deduction (hold → taken)', async () => {
    const req = await submit();
    await svc.approve(req.id, 'mgr-1');
    await svc.markSynced(req.id);
    expect((await svc.getById(req.id)).status).toBe('SYNCED');
    const b = await bal();
    expect(b.taken).toBe(3);
    expect(b.pendingHolds).toBe(0);
  });

  it('markSyncFailed releases the hold and records the reason (D5)', async () => {
    const req = await submit();
    await svc.approve(req.id, 'mgr-1');
    await svc.markSyncFailed(req.id, 'RETRIES_EXHAUSTED');
    const updated = await svc.getById(req.id);
    expect(updated.status).toBe('SYNC_FAILED');
    expect(updated.failureReason).toBe('RETRIES_EXHAUSTED');
    expect(available(await bal())).toBe(10); // hold released
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

```bash
npx jest apps/time-off-service/src/requests/requests.service.spec.ts --verbose
```
Expected: FAIL — RequestsService not found.

- [ ] **Step 3: Implement**

```typescript
// apps/time-off-service/src/requests/requests.service.ts
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { TimeOffRequest } from '../entities/time-off-request.entity';
import { OutboxRow } from '../entities/outbox-row.entity';
import { BalancesService } from '../balances/balances.service';
import { nextStatus } from './state-machine';
import { AppError } from '../common/app-error';

export interface SubmitDto { employeeId: string; locationId: string; amountDays: number; }

@Injectable()
export class RequestsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly balances: BalancesService,
  ) {}

  async submit(dto: SubmitDto, idempotencyKey: string): Promise<TimeOffRequest> {
    if (!idempotencyKey) throw new AppError('VALIDATION_FAILED', 400, 'Idempotency-Key header required');
    if (!(dto.amountDays > 0)) throw new AppError('VALIDATION_FAILED', 400, 'amountDays must be > 0');
    const existing = await this.findByIdempotencyKey(idempotencyKey);
    if (existing) return existing; // D3: replay returns the original

    const id = randomUUID();
    const now = new Date().toISOString();
    return this.dataSource.transaction(async (em) => {
      // placeHold validates dimensions + sufficiency (D1) and appends HOLD_PLACED, all in this TX
      await this.balances.placeHoldInTx(em, dto.employeeId, dto.locationId, dto.amountDays, id);
      const req = em.create(TimeOffRequest, {
        id, ...dto, status: 'PENDING', idempotencyKey,
        managerId: null, failureReason: null, createdAt: now, updatedAt: now,
      });
      await em.save(req);
      return req;
    });
  }

  async approve(id: string, managerId: string): Promise<TimeOffRequest> {
    return this.dataSource.transaction(async (em) => {
      const req = await em.findOneBy(TimeOffRequest, { id });
      if (!req) throw new AppError('NOT_FOUND', 404);
      req.status = nextStatus(req.status, 'approve');
      req.managerId = managerId;
      req.updatedAt = new Date().toISOString();
      await em.save(req);
      await em.insert(OutboxRow, {
        id: randomUUID(), requestId: req.id, operation: 'DEDUCT',
        payload: JSON.stringify({ employeeId: req.employeeId, locationId: req.locationId, amountDays: req.amountDays }),
        idempotencyKey: `deduct-${req.id}`, status: 'PENDING', attempts: 0,
        nextRetryAt: null, lastError: null, createdAt: req.updatedAt,
      });
      return req;
    });
  }

  async deny(id: string, managerId: string): Promise<TimeOffRequest> {
    return this.releaseFlow(id, 'deny', managerId);
  }

  async cancel(id: string): Promise<TimeOffRequest> {
    return this.releaseFlow(id, 'cancel', null);
  }

  private async releaseFlow(id: string, action: 'deny' | 'cancel', managerId: string | null): Promise<TimeOffRequest> {
    return this.dataSource.transaction(async (em) => {
      const req = await em.findOneBy(TimeOffRequest, { id });
      if (!req) throw new AppError('NOT_FOUND', 404);
      req.status = nextStatus(req.status, action);
      if (managerId) req.managerId = managerId;
      req.updatedAt = new Date().toISOString();
      await em.save(req);
      await this.balances.releaseHoldInTx(em, req.employeeId, req.locationId, req.amountDays, req.id);
      return req;
    });
  }

  /** Called by the outbox dispatcher after verified HCM success. */
  async markSynced(id: string): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      const req = await em.findOneByOrFail(TimeOffRequest, { id });
      req.status = nextStatus(req.status, 'syncSucceed');
      req.updatedAt = new Date().toISOString();
      await em.save(req);
      await this.balances.confirmDeductionInTx(em, req.employeeId, req.locationId, req.amountDays, req.id);
    });
  }

  /** Called by the dispatcher on permanent failure: release the hold, keep the audit trail (D5). */
  async markSyncFailed(id: string, reason: string): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      const req = await em.findOneByOrFail(TimeOffRequest, { id });
      req.status = nextStatus(req.status, 'syncFail');
      req.failureReason = reason;
      req.updatedAt = new Date().toISOString();
      await em.save(req);
      await this.balances.releaseHoldInTx(em, req.employeeId, req.locationId, req.amountDays, req.id);
    });
  }

  async getById(id: string): Promise<TimeOffRequest> {
    const req = await this.dataSource.manager.findOneBy(TimeOffRequest, { id });
    if (!req) throw new AppError('NOT_FOUND', 404);
    return req;
  }

  async findByIdempotencyKey(key: string): Promise<TimeOffRequest | null> {
    return this.dataSource.manager.findOneBy(TimeOffRequest, { idempotencyKey: key });
  }

  async list(filter: { employeeId?: string; locationId?: string; status?: string }): Promise<TimeOffRequest[]> {
    const where: Record<string, string> = {};
    if (filter.employeeId) where.employeeId = filter.employeeId;
    if (filter.locationId) where.locationId = filter.locationId;
    if (filter.status) where.status = filter.status;
    return this.dataSource.manager.find(TimeOffRequest, { where, order: { createdAt: 'DESC' } });
  }
}
```

**Refactor note (do in this step):** `submit`, `releaseFlow`, `markSynced`, and `markSyncFailed` need the balance mutation inside *their* transaction. Refactor `BalancesService` so each mutation has an `…InTx(em, …)` variant containing the logic, and the public method wraps it in `dataSource.transaction`:

```typescript
// in balances.service.ts — pattern for all three mutators:
async placeHold(employeeId: string, locationId: string, amountDays: number, requestId: string): Promise<void> {
  await this.dataSource.transaction((em) => this.placeHoldInTx(em, employeeId, locationId, amountDays, requestId));
}

async placeHoldInTx(em: EntityManager, employeeId: string, locationId: string, amountDays: number, requestId: string): Promise<void> {
  const b = await em.findOneBy(Balance, { employeeId, locationId });
  if (!b) throw new AppError('INVALID_DIMENSIONS', 422, 'unknown employee/location balance');
  if (available(b) < amountDays) throw new AppError('INSUFFICIENT_BALANCE', 422);
  b.pendingHolds += amountDays;
  await em.save(b);
  await this.ledger.append(em, {
    employeeId, locationId, entryType: 'HOLD_PLACED',
    amount: -amountDays, balanceAfter: available(b), requestId, detail: null,
  });
}
// releaseHold/releaseHoldInTx and confirmDeduction/confirmDeductionInTx follow the identical pattern,
// preserving the exact ledger entries from Task 6.
```
Task 6's tests must still pass unchanged after this refactor.

```typescript
// apps/time-off-service/src/requests/requests.module.ts
import { Module } from '@nestjs/common';
import { BalancesModule } from '../balances/balances.module';
import { RequestsService } from './requests.service';

@Module({ imports: [BalancesModule], providers: [RequestsService], exports: [RequestsService] })
export class RequestsModule {}
```

- [ ] **Step 4: Run requests + balances tests — expect pass**

```bash
npx jest apps/time-off-service/src/requests apps/time-off-service/src/balances --verbose
```
Expected: all pass (refactor verified against Task 6 suite).

- [ ] **Step 5: Commit**

```bash
git add apps/time-off-service/src
git commit -m "feat(service): request lifecycle service with idempotent submit and atomic outbox enqueue"
```

---

### Task 9: HTTP layer — controllers, app module, integration spec

**Files:**
- Create: `apps/time-off-service/src/requests/requests.controller.ts`, `apps/time-off-service/src/balances/balances.controller.ts`
- Modify: `apps/time-off-service/src/app.module.ts`, `apps/time-off-service/src/main.ts` (delete CLI-generated app.controller/app.service + specs)
- Test: `apps/time-off-service/test/integration/http.spec.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/time-off-service/test/integration/http.spec.ts
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { buildTestApp } from '../utils';
import { BalancesService } from '../../src/balances/balances.service';

describe('HTTP API', () => {
  let app: INestApplication;

  beforeEach(async () => {
    app = await buildTestApp();
    await app.get(BalancesService).applyBatch([{ employeeId: 'e1', locationId: 'l1', balanceDays: 10 }]);
  });
  afterEach(async () => { await app.close(); });

  const http = () => request(app.getHttpServer());

  it('submit → 201 PENDING; missing Idempotency-Key → 400 problem+json', async () => {
    const res = await http().post('/time-off-requests')
      .set('Idempotency-Key', 'k1')
      .send({ employeeId: 'e1', locationId: 'l1', amountDays: 3 })
      .expect(201);
    expect(res.body.status).toBe('PENDING');

    const err = await http().post('/time-off-requests')
      .send({ employeeId: 'e1', locationId: 'l1', amountDays: 3 })
      .expect(400);
    expect(err.headers['content-type']).toContain('application/problem+json');
    expect(err.body.title).toBe('VALIDATION_FAILED');
  });

  it('insufficient balance → 422 INSUFFICIENT_BALANCE problem+json', async () => {
    const res = await http().post('/time-off-requests')
      .set('Idempotency-Key', 'k2')
      .send({ employeeId: 'e1', locationId: 'l1', amountDays: 99 })
      .expect(422);
    expect(res.body.title).toBe('INSUFFICIENT_BALANCE');
  });

  it('approve → 200 APPROVED; re-approve → 409 INVALID_TRANSITION', async () => {
    const created = await http().post('/time-off-requests')
      .set('Idempotency-Key', 'k3')
      .send({ employeeId: 'e1', locationId: 'l1', amountDays: 2 }).expect(201);
    const id = created.body.id;
    await http().post(`/time-off-requests/${id}/approve`).send({ managerId: 'm1' }).expect(200);
    const conflict = await http().post(`/time-off-requests/${id}/approve`).send({ managerId: 'm1' }).expect(409);
    expect(conflict.body.title).toBe('INVALID_TRANSITION');
  });

  it('GET /balances/:emp/:loc returns projection with availableDays', async () => {
    const res = await http().get('/balances/e1/l1').expect(200);
    expect(res.body).toMatchObject({
      employeeId: 'e1', locationId: 'l1',
      accruedBaseline: 10, pendingHolds: 0, taken: 0, availableDays: 10,
    });
    await http().get('/balances/eX/lX').expect(404);
  });

  it('list filters by status', async () => {
    await http().post('/time-off-requests').set('Idempotency-Key', 'k4')
      .send({ employeeId: 'e1', locationId: 'l1', amountDays: 1 }).expect(201);
    const res = await http().get('/time-off-requests?employeeId=e1&status=PENDING').expect(200);
    expect(res.body).toHaveLength(1);
    const none = await http().get('/time-off-requests?employeeId=e1&status=SYNCED').expect(200);
    expect(none.body).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Add `buildTestApp` to `apps/time-off-service/test/utils.ts`**

```typescript
// append to apps/time-off-service/test/utils.ts
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { ProblemJsonFilter } from '../src/common/problem-json.filter';

export async function buildTestApp(): Promise<INestApplication> {
  process.env.DB_PATH = ':memory:';
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = mod.createNestApplication();
  app.useGlobalFilters(new ProblemJsonFilter());
  await app.init();
  return app;
}
```

- [ ] **Step 3: Run tests — expect failure**

```bash
npx jest apps/time-off-service/test/integration/http.spec.ts --verbose
```
Expected: FAIL — controllers/AppModule wiring missing.

- [ ] **Step 4: Implement controllers and wire the app module**

```typescript
// apps/time-off-service/src/requests/requests.controller.ts
import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { RequestsService, SubmitDto } from './requests.service';

@Controller('time-off-requests')
export class RequestsController {
  constructor(private readonly requests: RequestsService) {}

  @Post()
  submit(@Body() dto: SubmitDto, @Headers('idempotency-key') idempotencyKey: string) {
    return this.requests.submit(dto, idempotencyKey);
  }

  @Get()
  list(
    @Query('employeeId') employeeId?: string,
    @Query('locationId') locationId?: string,
    @Query('status') status?: string,
  ) {
    return this.requests.list({ employeeId, locationId, status });
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.requests.getById(id);
  }

  @Post(':id/approve')
  @HttpCode(200)
  approve(@Param('id') id: string, @Body() body: { managerId: string }) {
    return this.requests.approve(id, body.managerId);
  }

  @Post(':id/deny')
  @HttpCode(200)
  deny(@Param('id') id: string, @Body() body: { managerId: string }) {
    return this.requests.deny(id, body.managerId);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Param('id') id: string) {
    return this.requests.cancel(id);
  }
}
```

```typescript
// apps/time-off-service/src/balances/balances.controller.ts
import { Controller, Get, Param } from '@nestjs/common';
import { BalancesService } from './balances.service';
import { available } from '../entities/balance.entity';

@Controller('balances')
export class BalancesController {
  constructor(private readonly balances: BalancesService) {}

  @Get(':employeeId/:locationId')
  async getBalance(@Param('employeeId') employeeId: string, @Param('locationId') locationId: string) {
    const b = await this.balances.getBalance(employeeId, locationId);
    return { ...b, availableDays: available(b) };
  }
}
```

```typescript
// apps/time-off-service/src/app.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Balance } from './entities/balance.entity';
import { TimeOffRequest } from './entities/time-off-request.entity';
import { LedgerEntry } from './entities/ledger-entry.entity';
import { OutboxRow } from './entities/outbox-row.entity';
import { LedgerModule } from './ledger/ledger.module';
import { BalancesModule } from './balances/balances.module';
import { RequestsModule } from './requests/requests.module';
import { BalancesController } from './balances/balances.controller';
import { RequestsController } from './requests/requests.controller';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'better-sqlite3',
      database: process.env.DB_PATH ?? 'data/timeoff.sqlite',
      entities: [Balance, TimeOffRequest, LedgerEntry, OutboxRow],
      synchronize: true, // take-home scope; production would use migrations (TRD §12)
    }),
    LedgerModule,
    BalancesModule,
    RequestsModule,
  ],
  controllers: [BalancesController, RequestsController],
})
export class AppModule {}
```

```typescript
// apps/time-off-service/src/main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ProblemJsonFilter } from './common/problem-json.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalFilters(new ProblemJsonFilter());
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
```

Delete the CLI-generated `app.controller.ts`, `app.service.ts`, and `app.controller.spec.ts` in `apps/time-off-service/src/`.

- [ ] **Step 5: Run all service tests — expect pass**

```bash
npx jest apps/time-off-service --verbose
```
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/time-off-service
git commit -m "feat(service): REST controllers with problem+json errors"
```

---

### Task 10: HcmClient — HTTP client with timeout

Tests boot the real `mock-hcm` app on an ephemeral port (no HTTP mocking — the client's failure behavior IS the unit under test).

**Files:**
- Create: `apps/time-off-service/src/hcm-sync/hcm-client.ts`
- Modify: `apps/time-off-service/test/utils.ts` (add `bootMockHcm`)
- Test: `apps/time-off-service/src/hcm-sync/hcm-client.spec.ts`

- [ ] **Step 1: Add `bootMockHcm` to test utils**

```typescript
// append to apps/time-off-service/test/utils.ts
import { MockHcmModule } from '../../mock-hcm/src/mock-hcm.module';
import { BalanceStoreService } from '../../mock-hcm/src/balance-store.service';

export interface MockHcm { app: INestApplication; baseUrl: string; store: BalanceStoreService; }

export async function bootMockHcm(): Promise<MockHcm> {
  const mod = await Test.createTestingModule({ imports: [MockHcmModule] }).compile();
  const app = mod.createNestApplication();
  await app.listen(0); // ephemeral port
  const baseUrl = await app.getUrl();
  return { app, baseUrl: baseUrl.replace('[::1]', '127.0.0.1'), store: app.get(BalanceStoreService) };
}
```

If the cross-app import fails to compile, add to root `tsconfig.json` `compilerOptions.paths`: `"@mock-hcm/*": ["apps/mock-hcm/src/*"]` and matching `moduleNameMapper` in the jest config: `"^@mock-hcm/(.*)$": "<rootDir>/apps/mock-hcm/src/$1"` — then import from `@mock-hcm/mock-hcm.module`.

- [ ] **Step 2: Write the failing tests**

```typescript
// apps/time-off-service/src/hcm-sync/hcm-client.spec.ts
import { HcmClient, HcmUnavailableError } from './hcm-client';
import { bootMockHcm, MockHcm } from '../../test/utils';

describe('HcmClient', () => {
  let hcm: MockHcm;
  let client: HcmClient;

  beforeEach(async () => {
    hcm = await bootMockHcm();
    client = new HcmClient(hcm.baseUrl, 500); // 500ms timeout
    hcm.store.set('e1', 'l1', 10);
  });
  afterEach(async () => { await hcm.app.close(); });

  it('getBalance returns the value, null for unknown dimensions', async () => {
    expect(await client.getBalance('e1', 'l1')).toBe(10);
    expect(await client.getBalance('eX', 'lX')).toBeNull();
  });

  it('postDeduction applies and reports ok', async () => {
    const res = await client.postDeduction({ idempotencyKey: 'k1', employeeId: 'e1', locationId: 'l1', amountDays: 3 });
    expect(res).toEqual({ ok: true });
    expect(hcm.store.get('e1', 'l1')).toBe(7);
  });

  it('postDeduction surfaces HCM rejection codes without throwing', async () => {
    const res = await client.postDeduction({ idempotencyKey: 'k2', employeeId: 'e1', locationId: 'l1', amountDays: 99 });
    expect(res).toEqual({ ok: false, code: 'INSUFFICIENT_BALANCE' });
  });

  it('hasDeduction reports verification status', async () => {
    expect(await client.hasDeduction('k1')).toBe(false);
    await client.postDeduction({ idempotencyKey: 'k1', employeeId: 'e1', locationId: 'l1', amountDays: 1 });
    expect(await client.hasDeduction('k1')).toBe(true);
  });

  it('getBatch returns the corpus', async () => {
    expect(await client.getBatch()).toEqual([{ employeeId: 'e1', locationId: 'l1', balanceDays: 10 }]);
  });

  it('throws HcmUnavailableError on timeout (chaos mode)', async () => {
    hcm.store.chaosMode = 'timeout';
    await expect(client.getBalance('e1', 'l1')).rejects.toThrow(HcmUnavailableError);
  }, 10_000);

  it('throws HcmUnavailableError on 500 (chaos mode)', async () => {
    hcm.store.chaosMode = 'error500';
    await expect(
      client.postDeduction({ idempotencyKey: 'k3', employeeId: 'e1', locationId: 'l1', amountDays: 1 }),
    ).rejects.toThrow(HcmUnavailableError);
  });
});
```

- [ ] **Step 3: Run tests — expect failure**

```bash
npx jest apps/time-off-service/src/hcm-sync --verbose
```
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

```typescript
// apps/time-off-service/src/hcm-sync/hcm-client.ts
import { Injectable } from '@nestjs/common';

export class HcmUnavailableError extends Error {}

export interface DeductionPayload { idempotencyKey: string; employeeId: string; locationId: string; amountDays: number; }
export interface HcmBatchEntry { employeeId: string; locationId: string; balanceDays: number; }
export type DeductionResponse = { ok: true } | { ok: false; code: string };

@Injectable()
export class HcmClient {
  constructor(
    private readonly baseUrl: string = process.env.HCM_BASE_URL ?? 'http://localhost:3001',
    private readonly timeoutMs: number = Number(process.env.HCM_TIMEOUT_MS ?? 2000),
  ) {}

  private async request(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new HcmUnavailableError(`HCM unreachable: ${String(e)}`);
    }
  }

  async getBalance(employeeId: string, locationId: string): Promise<number | null> {
    const res = await this.request(`/balances/${employeeId}/${locationId}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new HcmUnavailableError(`HCM ${res.status}`);
    return (await res.json()).balanceDays as number;
  }

  /** 4xx with a code is an HCM *decision* (returned); 5xx/network is unavailability (thrown). */
  async postDeduction(payload: DeductionPayload): Promise<DeductionResponse> {
    const res = await this.request('/deductions', { method: 'POST', body: JSON.stringify(payload) });
    if (res.ok) return { ok: true };
    if (res.status >= 400 && res.status < 500) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, code: body.code ?? `HCM_${res.status}` };
    }
    throw new HcmUnavailableError(`HCM ${res.status}`);
  }

  async hasDeduction(idempotencyKey: string): Promise<boolean> {
    const res = await this.request(`/deductions/${idempotencyKey}`);
    if (res.status === 404) return false;
    if (!res.ok) throw new HcmUnavailableError(`HCM ${res.status}`);
    return true;
  }

  async getBatch(): Promise<HcmBatchEntry[]> {
    const res = await this.request('/batch');
    if (!res.ok) throw new HcmUnavailableError(`HCM ${res.status}`);
    return (await res.json()).balances as HcmBatchEntry[];
  }
}
```

- [ ] **Step 5: Run tests — expect pass**

```bash
npx jest apps/time-off-service/src/hcm-sync --verbose
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/time-off-service/src/hcm-sync apps/time-off-service/test/utils.ts
git commit -m "feat(service): HCM client with timeout and decision-vs-unavailability split"
```

---

### Task 11: OutboxDispatcher — send → verify → confirm/retry/fail

The defensive core (TRD §7.1, D2/D3/D5). `processOnce()` is the unit; the interval scheduler is a thin wrapper so tests can drive ticks deterministically.

**Note — TRD amendment in this task:** verification uses `GET /deductions/:idempotencyKey` (existence by key) rather than comparing balance values, because out-of-band balance changes would confound a numeric compare. Update `TRD.md` §7.1 step 2 to read: *"**Verify:** confirm the deduction landed by looking it up by idempotency key (`GET /deductions/:key`). A `2xx` write response is not trusted on its own (challenge C4 — silent failures); a numeric balance compare is not used because out-of-band changes would confound it."*

Also amend §7.1 step 4: permanent failure is recorded on the request itself (`failure_reason`) and surfaced via the drift report's `syncFailedRequests`; the only ledger entry written is the `HOLD_RELEASED` from releasing the hold (a zero-amount `RECONCILIATION_ADJUSTMENT` would add noise without information). Commit both TRD edits with the task.

**Files:**
- Create: `apps/time-off-service/src/hcm-sync/outbox-dispatcher.ts`, `apps/time-off-service/src/hcm-sync/hcm-sync.module.ts`
- Modify: `TRD.md` (§7.1 step 2, wording above)
- Test: `apps/time-off-service/src/hcm-sync/outbox-dispatcher.spec.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/time-off-service/src/hcm-sync/outbox-dispatcher.spec.ts
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { buildTestApp, bootMockHcm, MockHcm } from '../../test/utils';
import { OutboxDispatcher } from './outbox-dispatcher';
import { RequestsService } from '../requests/requests.service';
import { BalancesService } from '../balances/balances.service';
import { Balance, available } from '../entities/balance.entity';
import { OutboxRow } from '../entities/outbox-row.entity';

describe('OutboxDispatcher', () => {
  let app: INestApplication;
  let hcm: MockHcm;
  let dispatcher: OutboxDispatcher;
  let requests: RequestsService;
  let ds: DataSource;

  beforeEach(async () => {
    hcm = await bootMockHcm();
    process.env.HCM_BASE_URL = hcm.baseUrl;
    process.env.HCM_TIMEOUT_MS = '300';
    app = await buildTestApp();
    dispatcher = app.get(OutboxDispatcher);
    requests = app.get(RequestsService);
    ds = app.get(DataSource);
    hcm.store.set('e1', 'l1', 10);
    await app.get(BalancesService).applyBatch([{ employeeId: 'e1', locationId: 'l1', balanceDays: 10 }]);
  });
  afterEach(async () => { await app.close(); await hcm.app.close(); });

  async function approvedRequest(amountDays = 3) {
    const req = await requests.submit({ employeeId: 'e1', locationId: 'l1', amountDays }, `k-${Math.random()}`);
    await requests.approve(req.id, 'm1');
    return req;
  }
  const outboxRow = (requestId: string) => ds.manager.findOneByOrFail(OutboxRow, { requestId });
  const bal = () => ds.manager.findOneByOrFail(Balance, { employeeId: 'e1', locationId: 'l1' });

  it('happy path: sends, verifies, marks VERIFIED and request SYNCED', async () => {
    const req = await approvedRequest();
    await dispatcher.processOnce();
    expect((await outboxRow(req.id)).status).toBe('VERIFIED');
    expect((await requests.getById(req.id)).status).toBe('SYNCED');
    expect(hcm.store.get('e1', 'l1')).toBe(7);
    const b = await bal();
    expect(b.taken).toBe(3);
    expect(b.pendingHolds).toBe(0);
  });

  it('silent failure (D2): 2xx without effect is retried, then succeeds once HCM heals', async () => {
    const req = await approvedRequest();
    hcm.store.chaosMode = 'silent-failure';
    await dispatcher.processOnce();
    let row = await outboxRow(req.id);
    expect(row.status).toBe('SENT');           // not VERIFIED — the lie was caught
    expect(row.attempts).toBe(1);
    expect((await requests.getById(req.id)).status).toBe('APPROVED');

    hcm.store.chaosMode = 'healthy';
    await dispatcher.processOnce({ ignoreBackoff: true });
    row = await outboxRow(req.id);
    expect(row.status).toBe('VERIFIED');
    expect((await requests.getById(req.id)).status).toBe('SYNCED');
  });

  it('unavailability (500s) schedules retry with backoff; nothing is lost', async () => {
    const req = await approvedRequest();
    hcm.store.chaosMode = 'error500';
    await dispatcher.processOnce();
    const row = await outboxRow(req.id);
    expect(row.status).toBe('SENT');
    expect(row.attempts).toBe(1);
    expect(row.nextRetryAt).not.toBeNull();
    expect(new Date(row.nextRetryAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it('respects nextRetryAt: a not-yet-due row is skipped', async () => {
    const req = await approvedRequest();
    hcm.store.chaosMode = 'error500';
    await dispatcher.processOnce();
    hcm.store.chaosMode = 'healthy';
    await dispatcher.processOnce(); // backoff not elapsed → skip
    expect((await outboxRow(req.id)).attempts).toBe(1);
  });

  it('explicit HCM rejection (out-of-band change, C1): SYNC_FAILED, hold released, drift visible', async () => {
    const req = await approvedRequest(3);
    hcm.store.set('e1', 'l1', 1); // HCM clawed back days after our approval
    await dispatcher.processOnce();
    expect((await outboxRow(req.id)).status).toBe('FAILED');
    const failed = await requests.getById(req.id);
    expect(failed.status).toBe('SYNC_FAILED');
    expect(failed.failureReason).toBe('INSUFFICIENT_BALANCE');
    expect(available(await bal())).toBe(10); // hold released locally
  });

  it('retries exhausted (D5): after maxAttempts the row FAILS and the request is SYNC_FAILED', async () => {
    const req = await approvedRequest();
    hcm.store.chaosMode = 'error500';
    for (let i = 0; i < 8; i++) await dispatcher.processOnce({ ignoreBackoff: true });
    expect((await outboxRow(req.id)).status).toBe('FAILED');
    const failed = await requests.getById(req.id);
    expect(failed.status).toBe('SYNC_FAILED');
    expect(failed.failureReason).toBe('RETRIES_EXHAUSTED');
    expect(available(await bal())).toBe(10);
  });

  it('idempotency (D3): re-processing a VERIFIED row is a no-op; HCM deducts once', async () => {
    const req = await approvedRequest();
    await dispatcher.processOnce();
    await dispatcher.processOnce({ ignoreBackoff: true });
    expect(hcm.store.get('e1', 'l1')).toBe(7);
    expect((await requests.getById(req.id)).status).toBe('SYNCED');
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

```bash
npx jest apps/time-off-service/src/hcm-sync/outbox-dispatcher.spec.ts --verbose
```
Expected: FAIL — OutboxDispatcher not found (and AppModule lacks HcmSyncModule).

- [ ] **Step 3: Implement dispatcher and module; wire into AppModule**

```typescript
// apps/time-off-service/src/hcm-sync/outbox-dispatcher.ts
import { Injectable, Logger } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { OutboxRow } from '../entities/outbox-row.entity';
import { HcmClient, HcmUnavailableError, DeductionPayload } from './hcm-client';
import { RequestsService } from '../requests/requests.service';

const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;

@Injectable()
export class OutboxDispatcher {
  private readonly logger = new Logger(OutboxDispatcher.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly client: HcmClient,
    private readonly requests: RequestsService,
  ) {}

  /** One dispatch pass. Tests call this directly; the scheduler calls it on an interval. */
  async processOnce(opts: { ignoreBackoff?: boolean } = {}): Promise<void> {
    const rows = await this.dataSource.manager.findBy(OutboxRow, { status: In(['PENDING', 'SENT']) });
    const now = Date.now();
    for (const row of rows) {
      if (!opts.ignoreBackoff && row.nextRetryAt && new Date(row.nextRetryAt).getTime() > now) continue;
      await this.processRow(row);
    }
  }

  private async processRow(row: OutboxRow): Promise<void> {
    const payload: DeductionPayload = { ...JSON.parse(row.payload), idempotencyKey: row.idempotencyKey };
    try {
      const response = await this.client.postDeduction(payload);
      // D2: never trust the write response alone — verify by idempotency-key lookup.
      const applied = await this.client.hasDeduction(row.idempotencyKey);
      if (applied) return this.succeed(row);
      if (!response.ok) return this.fail(row, response.code); // explicit HCM decision: permanent
      return this.scheduleRetry(row, 'SILENT_FAILURE');       // 2xx but not applied: the lying HCM
    } catch (e) {
      if (e instanceof HcmUnavailableError) return this.scheduleRetry(row, e.message);
      throw e;
    }
  }

  private async succeed(row: OutboxRow): Promise<void> {
    await this.requests.markSynced(row.requestId); // confirms deduction (hold → taken) transactionally
    row.status = 'VERIFIED';
    row.lastError = null;
    await this.dataSource.manager.save(row);
  }

  private async fail(row: OutboxRow, reason: string): Promise<void> {
    row.status = 'FAILED';
    row.lastError = reason;
    await this.dataSource.manager.save(row);
    await this.requests.markSyncFailed(row.requestId, reason); // releases hold, records reason (D5)
    this.logger.warn(`outbox ${row.id} failed permanently: ${reason}`);
  }

  private async scheduleRetry(row: OutboxRow, error: string): Promise<void> {
    row.attempts += 1;
    row.lastError = error;
    if (row.attempts >= MAX_ATTEMPTS) return this.fail(row, 'RETRIES_EXHAUSTED');
    const backoff = Math.min(BASE_BACKOFF_MS * 2 ** row.attempts, MAX_BACKOFF_MS);
    const jitter = Math.floor(Math.random() * 250);
    row.status = 'SENT';
    row.nextRetryAt = new Date(Date.now() + backoff + jitter).toISOString();
    await this.dataSource.manager.save(row);
  }
}
```

Bug guard: in `fail()` called from `scheduleRetry` on exhaustion, `row.status` must end as `FAILED` (the early-return pattern above guarantees it — `fail` runs last).

```typescript
// apps/time-off-service/src/hcm-sync/hcm-sync.module.ts
import { Module } from '@nestjs/common';
import { RequestsModule } from '../requests/requests.module';
import { BalancesModule } from '../balances/balances.module';
import { LedgerModule } from '../ledger/ledger.module';
import { HcmClient } from './hcm-client';
import { OutboxDispatcher } from './outbox-dispatcher';

@Module({
  imports: [RequestsModule, BalancesModule, LedgerModule],
  providers: [
    { provide: HcmClient, useFactory: () => new HcmClient() }, // reads env at construction
    OutboxDispatcher,
  ],
  exports: [HcmClient, OutboxDispatcher],
})
export class HcmSyncModule {}
```

Add `HcmSyncModule` to `AppModule.imports`.

- [ ] **Step 4: Amend TRD §7.1 step 2** with the verification wording from this task's note, then run:

```bash
npx jest apps/time-off-service/src/hcm-sync --verbose
```
Expected: all dispatcher + client tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/time-off-service/src TRD.md
git commit -m "feat(service): outbox dispatcher with verification, backoff, and permanent-failure handling"
```

---

### Task 12: Reconciliation service, sync/drift/health endpoints, schedulers

**Files:**
- Create: `apps/time-off-service/src/hcm-sync/reconciliation.service.ts`, `apps/time-off-service/src/hcm-sync/sync.controller.ts`
- Modify: `apps/time-off-service/src/hcm-sync/hcm-sync.module.ts`, `apps/time-off-service/src/app.module.ts`
- Test: `apps/time-off-service/test/integration/reconciliation.spec.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/time-off-service/test/integration/reconciliation.spec.ts
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { buildTestApp, bootMockHcm, MockHcm } from '../utils';
import { RequestsService } from '../../src/requests/requests.service';
import { BalancesService } from '../../src/balances/balances.service';
import { OutboxDispatcher } from '../../src/hcm-sync/outbox-dispatcher';

describe('reconciliation + ops endpoints', () => {
  let app: INestApplication;
  let hcm: MockHcm;

  beforeEach(async () => {
    hcm = await bootMockHcm();
    process.env.HCM_BASE_URL = hcm.baseUrl;
    process.env.HCM_TIMEOUT_MS = '300';
    app = await buildTestApp();
    hcm.store.set('e1', 'l1', 10);
  });
  afterEach(async () => { await app.close(); await hcm.app.close(); });

  const http = () => request(app.getHttpServer());

  it('POST /sync/batch pulls the corpus from HCM and seeds projections', async () => {
    const res = await http().post('/sync/batch').expect(202);
    expect(res.body).toMatchObject({ created: 1, updated: 0 });
    const bal = await http().get('/balances/e1/l1').expect(200);
    expect(bal.body.availableDays).toBe(10);
  });

  it('anniversary bonus (C1): batch raises baseline, pending holds survive', async () => {
    await http().post('/sync/batch').expect(202);
    await app.get(RequestsService).submit({ employeeId: 'e1', locationId: 'l1', amountDays: 4 }, 'k1');
    hcm.store.set('e1', 'l1', 15); // out-of-band bonus in HCM
    await http().post('/sync/batch').expect(202);
    const bal = await http().get('/balances/e1/l1').expect(200);
    expect(bal.body).toMatchObject({ accruedBaseline: 15, pendingHolds: 4, availableDays: 11 });
  });

  it('GET /admin/reconciliation/drift lists negative balances and SYNC_FAILED requests', async () => {
    await http().post('/sync/batch').expect(202);
    const requests = app.get(RequestsService);
    const req = await requests.submit({ employeeId: 'e1', locationId: 'l1', amountDays: 3 }, 'k2');
    await requests.approve(req.id, 'm1');
    hcm.store.chaosMode = 'error500';
    const dispatcher = app.get(OutboxDispatcher);
    for (let i = 0; i < 8; i++) await dispatcher.processOnce({ ignoreBackoff: true });

    const drift = await http().get('/admin/reconciliation/drift').expect(200);
    expect(drift.body.syncFailedRequests).toHaveLength(1);
    expect(drift.body.syncFailedRequests[0].id).toBe(req.id);

    hcm.store.chaosMode = 'healthy';
    hcm.store.set('e1', 'l1', 0); // clawback below a new hold
    await requests.submit({ employeeId: 'e1', locationId: 'l1', amountDays: 5 }, 'k3');
    await http().post('/sync/batch').expect(202);
    const drift2 = await http().get('/admin/reconciliation/drift').expect(200);
    expect(drift2.body.negativeBalances).toEqual([
      { employeeId: 'e1', locationId: 'l1', available: -5 },
    ]);
  });

  it('GET /balances with ?verify=true cross-checks HCM and reports mismatch', async () => {
    await http().post('/sync/batch').expect(202);
    hcm.store.set('e1', 'l1', 12); // HCM moved, we have not synced
    const res = await http().get('/balances/e1/l1?verify=true').expect(200);
    expect(res.body.hcmVerification).toEqual({ hcmBalanceDays: 12, baselineMatches: false });
  });

  it('GET /health reports HCM reachability', async () => {
    await http().get('/health').expect(200);
    hcm.store.chaosMode = 'error500';
    await http().get('/health').expect(503);
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

```bash
npx jest apps/time-off-service/test/integration/reconciliation.spec.ts --verbose
```
Expected: FAIL — endpoints missing.

- [ ] **Step 3: Implement**

```typescript
// apps/time-off-service/src/hcm-sync/reconciliation.service.ts
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BalancesService, BatchSummary } from '../balances/balances.service';
import { HcmClient } from './hcm-client';
import { LedgerEntry } from '../entities/ledger-entry.entity';
import { TimeOffRequest } from '../entities/time-off-request.entity';
import { Balance, available } from '../entities/balance.entity';

@Injectable()
export class ReconciliationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly balances: BalancesService,
    private readonly client: HcmClient,
  ) {}

  async runBatchSync(): Promise<BatchSummary> {
    const corpus = await this.client.getBatch();
    return this.balances.applyBatch(corpus);
  }

  async driftReport() {
    const adjustments = await this.dataSource.manager.findBy(LedgerEntry, {
      entryType: 'RECONCILIATION_ADJUSTMENT',
    });
    const balances = await this.dataSource.manager.find(Balance);
    const negativeBalances = balances
      .filter((b) => available(b) < 0)
      .map((b) => ({ employeeId: b.employeeId, locationId: b.locationId, available: available(b) }));
    const syncFailedRequests = await this.dataSource.manager.findBy(TimeOffRequest, { status: 'SYNC_FAILED' });
    return { adjustments, negativeBalances, syncFailedRequests };
  }
}
```

```typescript
// apps/time-off-service/src/hcm-sync/sync.controller.ts
import { Controller, Get, HttpCode, Post, ServiceUnavailableException } from '@nestjs/common';
import { ReconciliationService } from './reconciliation.service';
import { HcmClient } from './hcm-client';

@Controller()
export class SyncController {
  constructor(
    private readonly reconciliation: ReconciliationService,
    private readonly client: HcmClient,
  ) {}

  @Post('sync/batch')
  @HttpCode(202)
  runBatch() {
    return this.reconciliation.runBatchSync();
  }

  @Get('admin/reconciliation/drift')
  drift() {
    return this.reconciliation.driftReport();
  }

  @Get('health')
  async health() {
    try {
      await this.client.getBatch();
      return { status: 'ok', hcm: 'reachable' };
    } catch {
      throw new ServiceUnavailableException({ status: 'degraded', hcm: 'unreachable' });
    }
  }
}
```

Add `?verify=true` to `BalancesController.getBalance` (inject `HcmClient`):

```typescript
// updated apps/time-off-service/src/balances/balances.controller.ts
import { Controller, Get, Param, Query } from '@nestjs/common';
import { BalancesService } from './balances.service';
import { available } from '../entities/balance.entity';
import { HcmClient } from '../hcm-sync/hcm-client';

@Controller('balances')
export class BalancesController {
  constructor(
    private readonly balances: BalancesService,
    private readonly client: HcmClient,
  ) {}

  @Get(':employeeId/:locationId')
  async getBalance(
    @Param('employeeId') employeeId: string,
    @Param('locationId') locationId: string,
    @Query('verify') verify?: string,
  ) {
    const b = await this.balances.getBalance(employeeId, locationId);
    const body: Record<string, unknown> = { ...b, availableDays: available(b) };
    if (verify === 'true') {
      const hcmBalanceDays = await this.client.getBalance(employeeId, locationId);
      body.hcmVerification = { hcmBalanceDays, baselineMatches: hcmBalanceDays === b.accruedBaseline };
    }
    return body;
  }
}
```

Register `ReconciliationService` + `SyncController` in `HcmSyncModule` (controllers: `[SyncController]`). Move `BalancesController` registration into a module that can see `HcmClient` — simplest: declare `BalancesController` in `HcmSyncModule` too and remove it from `AppModule.controllers`.

**Schedulers** (production wiring, excluded from tests): create `apps/time-off-service/src/hcm-sync/schedulers.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { Cron, Interval } from '@nestjs/schedule';
import { OutboxDispatcher } from './outbox-dispatcher';
import { ReconciliationService } from './reconciliation.service';

@Injectable()
export class HcmSyncSchedulers {
  constructor(
    private readonly dispatcher: OutboxDispatcher,
    private readonly reconciliation: ReconciliationService,
  ) {}

  @Interval(2000)
  dispatchTick() { return this.dispatcher.processOnce(); }

  @Cron('0 2 * * *') // nightly batch reconciliation
  nightlyBatch() { return this.reconciliation.runBatchSync(); }
}
```

In `AppModule`, import `ScheduleModule.forRoot()` and register `HcmSyncSchedulers` ONLY outside tests:

```typescript
// in app.module.ts imports array:
...(process.env.NODE_ENV === 'test' ? [] : [ScheduleModule.forRoot()]),
```
and provide `HcmSyncSchedulers` in `HcmSyncModule` the same conditional way. Set `NODE_ENV=test` inside `buildTestApp()` (add `process.env.NODE_ENV = 'test'` as its first line).

- [ ] **Step 4: Run the full service suite — expect pass**

```bash
npx jest apps/time-off-service --verbose
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/time-off-service/src apps/time-off-service/test
git commit -m "feat(service): batch reconciliation, drift report, health, verify-mode balance reads"
```

---

### Task 13: Property-based invariant suite (fast-check)

Random operation sequences against a trivially-correct reference model. Asserts I1/I2/I3 after every operation. This is the strongest regression fence in the repo.

**Files:**
- Test: `apps/time-off-service/test/property/invariants.spec.ts` (test-only task — the system under test already exists)

- [ ] **Step 1: Write the property suite**

```typescript
// apps/time-off-service/test/property/invariants.spec.ts
import fc from 'fast-check';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { buildTestApp } from '../utils';
import { RequestsService } from '../../src/requests/requests.service';
import { BalancesService } from '../../src/balances/balances.service';
import { LedgerService } from '../../src/ledger/ledger.service';
import { Balance, available } from '../../src/entities/balance.entity';
import { AppError } from '../../src/common/app-error';

const EMP = 'e1';
const LOC = 'l1';

type Op =
  | { kind: 'submit'; amount: number }
  | { kind: 'approve' } | { kind: 'deny' } | { kind: 'cancel' }
  | { kind: 'batchSync'; newBaseline: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant<'submit'>('submit'), amount: fc.integer({ min: 1, max: 5 }) }),
  fc.constant<Op>({ kind: 'approve' }),
  fc.constant<Op>({ kind: 'deny' }),
  fc.constant<Op>({ kind: 'cancel' }),
  fc.record({ kind: fc.constant<'batchSync'>('batchSync'), newBaseline: fc.integer({ min: 0, max: 30 }) }),
);

/** Trivially-correct reference model: same rules, no SQL, no transactions. */
class Model {
  baseline = 10; holds = 0; taken = 0;
  pending: { id: string; amount: number }[] = [];
  get available() { return this.baseline - this.taken - this.holds; }

  submit(id: string, amount: number): boolean {
    if (this.available < amount) return false;
    this.holds += amount;
    this.pending.push({ id, amount });
    return true;
  }
  takeFirstPending(): { id: string; amount: number } | undefined { return this.pending.shift(); }
  releaseHold(amount: number) { this.holds -= amount; }
  batchSync(newBaseline: number) { this.baseline = newBaseline; }
}

describe('invariants under random operation sequences', () => {
  jest.setTimeout(120_000);

  it('I1 (ledger == projection), I2 (no service-made negatives), model agreement', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 40 }), async (ops) => {
        const app: INestApplication = await buildTestApp();
        try {
          const requests = app.get(RequestsService);
          const balances = app.get(BalancesService);
          const ledger = app.get(LedgerService);
          const ds = app.get(DataSource);
          await balances.applyBatch([{ employeeId: EMP, locationId: LOC, balanceDays: 10 }]);
          const model = new Model();
          let seq = 0;

          for (const op of ops) {
            seq += 1;
            if (op.kind === 'submit') {
              const key = `pk-${seq}`;
              try {
                const req = await requests.submit({ employeeId: EMP, locationId: LOC, amountDays: op.amount }, key);
                const accepted = model.submit(req.id, op.amount);
                expect(accepted).toBe(true); // service accepted ⇒ model must agree
              } catch (e) {
                expect(e).toBeInstanceOf(AppError);
                expect(model.available).toBeLessThan(op.amount); // service rejected ⇒ model must agree
              }
            } else if (op.kind === 'approve' || op.kind === 'deny' || op.kind === 'cancel') {
              const target = model.takeFirstPending();
              if (!target) continue; // nothing pending — skip (no-op in both worlds)
              if (op.kind === 'approve') {
                await requests.approve(target.id, 'm1');
                // hold stays until dispatcher runs; model keeps the hold too: re-add as non-pending hold
                model.pending = model.pending.filter((p) => p.id !== target.id);
              } else {
                if (op.kind === 'deny') await requests.deny(target.id, 'm1');
                else await requests.cancel(target.id);
                model.releaseHold(target.amount);
              }
            } else {
              await balances.applyBatch([{ employeeId: EMP, locationId: LOC, balanceDays: op.newBaseline }]);
              model.batchSync(op.newBaseline);
            }

            // ---- invariants, checked after EVERY operation ----
            const b = await ds.manager.findOneByOrFail(Balance, { employeeId: EMP, locationId: LOC });
            const ledgerSum = await ledger.sumFor(ds.manager, EMP, LOC);
            expect(ledgerSum).toBeCloseTo(available(b), 9);            // I1
            expect(available(b)).toBeCloseTo(model.available, 9);      // model agreement
            if (op.kind !== 'batchSync') {
              expect(available(b)).toBeGreaterThanOrEqual(0);          // I2 (clawback exception is batch-only)
            }
            expect(b.pendingHolds).toBeGreaterThanOrEqual(0);
            expect(b.taken).toBeGreaterThanOrEqual(0);
          }
        } finally {
          await app.close();
        }
      }),
      { numRuns: 30 },
    );
  });
});
```

Note on `approve` in the model: approval keeps the hold (deduction confirms only after dispatcher verification, which this suite does not run), so the model simply stops tracking the request as pending while keeping `holds` unchanged. `available` is unaffected by approval — exactly what the service does.

- [ ] **Step 2: Run the suite**

```bash
npm run test:property
```
Expected: PASS (~30 runs × up to 40 ops). If it fails, fast-check prints the minimal counterexample sequence — fix the service (or the model if the model is wrong), never weaken the invariant.

- [ ] **Step 3: Commit**

```bash
git add apps/time-off-service/test/property
git commit -m "test(service): property-based invariant suite (ledger==projection, no negatives, model agreement)"
```

---

### Task 14: Chaos e2e suite — full system against the lying/dying HCM

Boots BOTH apps as real HTTP servers. Exercises the TRD's defensive claims end-to-end over the wire.

**Files:**
- Test: `apps/time-off-service/test/e2e/chaos.e2e-spec.ts`

- [ ] **Step 1: Write the chaos e2e suite**

```typescript
// apps/time-off-service/test/e2e/chaos.e2e-spec.ts
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { buildTestApp, bootMockHcm, MockHcm } from '../utils';
import { OutboxDispatcher } from '../../src/hcm-sync/outbox-dispatcher';

describe('chaos e2e: service vs hostile HCM', () => {
  let app: INestApplication;
  let hcm: MockHcm;
  let dispatcher: OutboxDispatcher;

  beforeEach(async () => {
    hcm = await bootMockHcm();
    process.env.HCM_BASE_URL = hcm.baseUrl;
    process.env.HCM_TIMEOUT_MS = '300';
    app = await buildTestApp();
    dispatcher = app.get(OutboxDispatcher);
    hcm.store.set('e1', 'l1', 10);
    await request(app.getHttpServer()).post('/sync/batch').expect(202);
  });
  afterEach(async () => { await app.close(); await hcm.app.close(); });

  const http = () => request(app.getHttpServer());

  async function submitAndApprove(key: string, amountDays: number): Promise<string> {
    const res = await http().post('/time-off-requests').set('Idempotency-Key', key)
      .send({ employeeId: 'e1', locationId: 'l1', amountDays }).expect(201);
    await http().post(`/time-off-requests/${res.body.id}/approve`).send({ managerId: 'm1' }).expect(200);
    return res.body.id;
  }

  it('golden path over the wire: request → approve → dispatch → SYNCED in both systems', async () => {
    const id = await submitAndApprove('g1', 3);
    await dispatcher.processOnce();
    const req = await http().get(`/time-off-requests/${id}`).expect(200);
    expect(req.body.status).toBe('SYNCED');
    expect(hcm.store.get('e1', 'l1')).toBe(7);
    const bal = await http().get('/balances/e1/l1?verify=true').expect(200);
    expect(bal.body.availableDays).toBe(7);
  });

  it('HCM timeout: approval still instant; request recovers after HCM heals', async () => {
    hcm.store.chaosMode = 'timeout';
    const id = await submitAndApprove('t1', 2); // approval is local — must succeed regardless
    await dispatcher.processOnce();
    expect((await http().get(`/time-off-requests/${id}`)).body.status).toBe('APPROVED');

    hcm.store.chaosMode = 'healthy';
    await dispatcher.processOnce({ ignoreBackoff: true });
    expect((await http().get(`/time-off-requests/${id}`)).body.status).toBe('SYNCED');
    expect(hcm.store.get('e1', 'l1')).toBe(8);
  });

  it('the lying HCM: silent failure is detected, retried, and never double-deducts', async () => {
    hcm.store.chaosMode = 'silent-failure';
    const id = await submitAndApprove('s1', 2);
    await dispatcher.processOnce();
    await dispatcher.processOnce({ ignoreBackoff: true });
    expect(hcm.store.get('e1', 'l1')).toBe(10); // nothing applied yet, and no phantom deduction

    hcm.store.chaosMode = 'healthy';
    await dispatcher.processOnce({ ignoreBackoff: true });
    expect((await http().get(`/time-off-requests/${id}`)).body.status).toBe('SYNCED');
    expect(hcm.store.get('e1', 'l1')).toBe(8); // exactly one deduction across all retries
  });

  it('out-of-band clawback between approval and dispatch: SYNC_FAILED, hold released, drift visible', async () => {
    const id = await submitAndApprove('c1', 5);
    hcm.store.set('e1', 'l1', 2); // HR clawed back days in HCM
    await dispatcher.processOnce();
    const req = await http().get(`/time-off-requests/${id}`).expect(200);
    expect(req.body.status).toBe('SYNC_FAILED');
    expect(req.body.failureReason).toBe('INSUFFICIENT_BALANCE');
    const bal = await http().get('/balances/e1/l1').expect(200);
    expect(bal.body.pendingHolds).toBe(0); // hold released
    const drift = await http().get('/admin/reconciliation/drift').expect(200);
    expect(drift.body.syncFailedRequests.map((r: { id: string }) => r.id)).toContain(id);
  });

  it('anniversary bonus during pending request: batch merge preserves the hold', async () => {
    await http().post('/time-off-requests').set('Idempotency-Key', 'a1')
      .send({ employeeId: 'e1', locationId: 'l1', amountDays: 4 }).expect(201);
    hcm.store.set('e1', 'l1', 20); // bonus lands in HCM
    await http().post('/sync/batch').expect(202);
    const bal = await http().get('/balances/e1/l1').expect(200);
    expect(bal.body).toMatchObject({ accruedBaseline: 20, pendingHolds: 4, availableDays: 16 });
  });

  it('duplicate submission over the wire: same Idempotency-Key, one hold', async () => {
    const body = { employeeId: 'e1', locationId: 'l1', amountDays: 3 };
    const r1 = await http().post('/time-off-requests').set('Idempotency-Key', 'd1').send(body).expect(201);
    const r2 = await http().post('/time-off-requests').set('Idempotency-Key', 'd1').send(body).expect(201);
    expect(r2.body.id).toBe(r1.body.id);
    expect((await http().get('/balances/e1/l1')).body.pendingHolds).toBe(3);
  });
});
```

- [ ] **Step 2: Run the suite**

```bash
npm run test:e2e:chaos
```
Expected: PASS. The timeout test takes ~1s (two 300ms client timeouts); the suite stays under ~15s.

- [ ] **Step 3: Run EVERYTHING**

```bash
npx jest --verbose
```
Expected: every suite in the repo passes.

- [ ] **Step 4: Commit**

```bash
git add apps/time-off-service/test/e2e
git commit -m "test(service): chaos e2e suite against lying/dying mock HCM"
```

---

### Task 15: Mutation testing, coverage, README

**Files:**
- Create: `stryker.config.json`, `README.md`

- [ ] **Step 1: Configure Stryker**

```json
// stryker.config.json
{
  "$schema": "https://raw.githubusercontent.com/stryker-mutator/stryker-js/master/packages/api/schema/stryker-core.json",
  "testRunner": "jest",
  "coverageAnalysis": "perTest",
  "mutate": [
    "apps/time-off-service/src/**/*.ts",
    "!apps/time-off-service/src/**/*.spec.ts",
    "!apps/time-off-service/src/main.ts",
    "!apps/time-off-service/src/**/*.module.ts",
    "!apps/time-off-service/src/hcm-sync/schedulers.ts"
  ],
  "jest": { "configFile": "package.json" },
  "thresholds": { "high": 85, "low": 70, "break": 60 }
}
```

- [ ] **Step 2: Run coverage and mutation, record the numbers**

```bash
npm run test:cov
npm run mutation
```
Expected: coverage report in `coverage/`; mutation score ≥ 60 (break threshold). Record both numbers for the README. If the mutation score is below 60, the surviving-mutant report names the untested logic — add the missing test, don't lower the threshold.

- [ ] **Step 3: Write README.md**

```markdown
# ReadyOn Time-Off Microservice

Time-off request lifecycle with HCM synchronization. See [TRD.md](./TRD.md) for the
full technical requirements, architecture, trade-off analysis, and defensive design.

## Quick start

\`\`\`bash
npm install
npm run start:mock-hcm     # mock HCM on :3001 (chaos modes: POST /chaos/mode)
npm run start:service      # service on :3000
\`\`\`

Walkthrough:
\`\`\`bash
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
\`\`\`

## Test suite (the point of this exercise)

| Layer | Command | What it fences |
|---|---|---|
| Unit + integration | `npx jest` | state machine edges, hold atomicity, idempotency, outbox |
| Property-based | `npm run test:property` | ledger==projection, no negatives, model agreement under random op sequences |
| Chaos e2e | `npm run test:e2e:chaos` | timeouts, 500s, silent failures, out-of-band changes — over real HTTP |
| Coverage | `npm run test:cov` | report in `coverage/` — <RECORD NUMBER HERE>% lines |
| Mutation | `npm run mutation` | StrykerJS score: <RECORD NUMBER HERE>% — proof the tests catch regressions |

CI runs all of the above on every push (`.github/workflows/ci.yml`).
```

(Replace the two `<RECORD NUMBER HERE>` placeholders with the actual numbers from Step 2 — leaving them is a task failure.)

- [ ] **Step 4: Commit**

```bash
git add stryker.config.json README.md
git commit -m "test: mutation testing config and README with coverage proof"
```

---

### Task 16: GitHub Actions CI

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write the workflow**

```yaml
# .github/workflows/ci.yml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run build
      - name: Unit + integration tests with coverage
        run: npm run test:cov -- --testPathIgnorePatterns 'test/e2e' 'test/property'
      - name: Property-based invariant suite
        run: npm run test:property
      - name: Chaos e2e suite
        run: npm run test:e2e:chaos
      - name: Upload coverage report (proof of coverage)
        uses: actions/upload-artifact@v4
        with:
          name: coverage-report
          path: coverage/
```

Enforce the coverage gate in jest (root `package.json` jest config):

```json
"coverageThreshold": { "global": { "branches": 80, "lines": 85 } }
```

- [ ] **Step 2: Validate locally**

```bash
npm run lint && npm run build && npm run test:cov -- --testPathIgnorePatterns 'test/e2e' 'test/property' && npm run test:property && npm run test:e2e:chaos
```
Expected: every stage green — this is exactly what CI will run.

- [ ] **Step 3: Commit**

```bash
git add .github package.json
git commit -m "ci: GitHub Actions pipeline with coverage gate and artifact upload"
```

---

## Final verification (after all tasks)

```bash
npx jest --verbose          # everything green
npm run test:cov            # coverage ≥ thresholds
npm run mutation            # score ≥ 60 (record in README)
npm run start:mock-hcm &    # manual smoke test per README walkthrough
npm run start:service &
```

Deliverables checklist (from the exercise PDF):
- [ ] `TRD.md` — challenges, solution, alternatives analysis ✅ (written before implementation)
- [ ] Code in a GitHub repository — push to GitHub when the user is ready (`gh repo create`)
- [ ] Test cases + proof of coverage — CI artifact + README numbers
