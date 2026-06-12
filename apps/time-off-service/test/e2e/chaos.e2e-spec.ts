// apps/time-off-service/test/e2e/chaos.e2e-spec.ts
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { buildTestApp, bootMockHcm, MockHcm } from '../utils';
import { OutboxDispatcher } from '../../src/hcm-sync/outbox-dispatcher';

process.env.MOCK_HCM_TIMEOUT_MS = '2000';

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
