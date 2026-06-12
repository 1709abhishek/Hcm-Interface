// apps/time-off-service/src/hcm-sync/outbox-dispatcher.spec.ts
process.env.MOCK_HCM_TIMEOUT_MS = '2000';

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
