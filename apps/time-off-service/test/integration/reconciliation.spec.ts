/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
// Test file: res.body and app.getHttpServer() from supertest/NestJS are intentionally untyped in integration tests
process.env.MOCK_HCM_TIMEOUT_MS = '2000';

// apps/time-off-service/test/integration/reconciliation.spec.ts
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { buildTestApp, bootMockHcm, MockHcm } from '../utils';
import { RequestsService } from '../../src/requests/requests.service';
import { OutboxDispatcher } from '../../src/hcm-sync/outbox-dispatcher';
import { BalancesService } from '../../src/balances/balances.service';

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
  afterEach(async () => {
    await app.close();
    await hcm.app.close();
  });

  const http = () => request(app.getHttpServer());

  it('POST /sync/batch pulls the corpus from HCM and seeds projections', async () => {
    const res = await http().post('/sync/batch').expect(202);
    expect(res.body).toMatchObject({ created: 1, updated: 0 });
    const bal = await http().get('/balances/e1/l1').expect(200);
    expect(bal.body.availableDays).toBe(10);
  });

  it('anniversary bonus (C1): batch raises baseline, pending holds survive', async () => {
    await http().post('/sync/batch').expect(202);
    await app
      .get(RequestsService)
      .submit({ employeeId: 'e1', locationId: 'l1', amountDays: 4 }, 'k1');
    hcm.store.set('e1', 'l1', 15); // out-of-band bonus in HCM
    await http().post('/sync/batch').expect(202);
    const bal = await http().get('/balances/e1/l1').expect(200);
    expect(bal.body).toMatchObject({
      accruedBaseline: 15,
      pendingHolds: 4,
      availableDays: 11,
    });
  });

  it('GET /admin/reconciliation/drift lists negative balances and SYNC_FAILED requests', async () => {
    await http().post('/sync/batch').expect(202);
    const requests = app.get(RequestsService);
    const req = await requests.submit(
      { employeeId: 'e1', locationId: 'l1', amountDays: 3 },
      'k2',
    );
    await requests.approve(req.id, 'm1');
    hcm.store.chaosMode = 'error500';
    const dispatcher = app.get(OutboxDispatcher);
    for (let i = 0; i < 8; i++)
      await dispatcher.processOnce({ ignoreBackoff: true });

    const drift = await http().get('/admin/reconciliation/drift').expect(200);
    expect(drift.body.syncFailedRequests).toHaveLength(1);
    expect(drift.body.syncFailedRequests[0].id).toBe(req.id);

    hcm.store.chaosMode = 'healthy';
    hcm.store.set('e1', 'l1', 0); // clawback below a new hold
    await requests.submit(
      { employeeId: 'e1', locationId: 'l1', amountDays: 5 },
      'k3',
    );
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
    expect(res.body.hcmVerification).toEqual({
      hcmBalanceDays: 12,
      baselineMatches: false,
    });
  });

  it('GET /health reports HCM reachability', async () => {
    await http().get('/health').expect(200);
    hcm.store.chaosMode = 'error500';
    await http().get('/health').expect(503);
  });

  it('employees absent from a batch are left untouched (absence is not deletion)', async () => {
    // Seed e1/l1 via applyBatch directly (simulates prior sync)
    const balances = app.get(BalancesService);
    await balances.applyBatch([
      { employeeId: 'e1', locationId: 'l1', balanceDays: 10 },
    ]);

    // Verify e1 exists with the seeded balance
    const before = await http().get('/balances/e1/l1').expect(200);
    expect(before.body.availableDays).toBe(10);
    const originalSyncedAt: string = before.body.lastSyncedAt as string;

    // Apply a batch that only contains e2 — e1 is absent
    await balances.applyBatch([
      { employeeId: 'e2', locationId: 'l2', balanceDays: 5 },
    ]);

    // e1's projection must be unchanged (absence ≠ deletion — TRD §7.2)
    const after = await http().get('/balances/e1/l1').expect(200);
    expect(after.body.availableDays).toBe(10);
    expect(after.body.accruedBaseline).toBe(10);
    expect(after.body.lastSyncedAt).toBe(originalSyncedAt);
  });
});
