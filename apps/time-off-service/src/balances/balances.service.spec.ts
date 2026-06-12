// apps/time-off-service/src/balances/balances.service.spec.ts
import { DataSource } from 'typeorm';
import { createTestDataSource } from '../../test/utils';
import { BalancesService } from './balances.service';
import { LedgerService } from '../ledger/ledger.service';
import { DbMutex } from '../common/db-mutex';
import { AppError } from '../common/app-error';
import { Balance, available } from '../entities/balance.entity';

describe('BalancesService', () => {
  let ds: DataSource;
  let ledger: LedgerService;
  let svc: BalancesService;

  beforeEach(async () => {
    ds = await createTestDataSource();
    ledger = new LedgerService();
    svc = new BalancesService(ds, ledger, new DbMutex());
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
