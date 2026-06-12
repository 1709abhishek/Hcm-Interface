// apps/time-off-service/src/requests/requests.service.spec.ts
import { DataSource } from 'typeorm';
import { createTestDataSource } from '../../test/utils';
import { RequestsService } from './requests.service';
import { BalancesService } from '../balances/balances.service';
import { LedgerService } from '../ledger/ledger.service';
import { DbMutex } from '../common/db-mutex';
import { Balance, available } from '../entities/balance.entity';
import { OutboxRow } from '../entities/outbox-row.entity';
import { AppError } from '../common/app-error';

describe('RequestsService', () => {
  let ds: DataSource;
  let balances: BalancesService;
  let svc: RequestsService;

  beforeEach(async () => {
    ds = await createTestDataSource();
    const mutex = new DbMutex();
    balances = new BalancesService(ds, new LedgerService(), mutex);
    svc = new RequestsService(ds, balances, mutex);
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
