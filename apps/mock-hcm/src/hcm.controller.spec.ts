import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
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
