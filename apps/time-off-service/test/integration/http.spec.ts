/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */
// Test file: res.body and app.getHttpServer() from supertest/NestJS are intentionally untyped in HTTP integration tests
// apps/time-off-service/test/integration/http.spec.ts
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { buildTestApp } from '../utils';
import { BalancesService } from '../../src/balances/balances.service';

describe('HTTP API', () => {
  let app: INestApplication;

  beforeEach(async () => {
    app = await buildTestApp();
    await app
      .get(BalancesService)
      .applyBatch([{ employeeId: 'e1', locationId: 'l1', balanceDays: 10 }]);
  });
  afterEach(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  it('submit → 201 PENDING; missing Idempotency-Key → 400 problem+json', async () => {
    const res = await http()
      .post('/time-off-requests')
      .set('Idempotency-Key', 'k1')
      .send({ employeeId: 'e1', locationId: 'l1', amountDays: 3 })
      .expect(201);
    expect(res.body.status).toBe('PENDING');

    const err = await http()
      .post('/time-off-requests')
      .send({ employeeId: 'e1', locationId: 'l1', amountDays: 3 })
      .expect(400);
    expect(err.headers['content-type']).toContain('application/problem+json');
    expect(err.body.title).toBe('VALIDATION_FAILED');
  });

  it('insufficient balance → 422 INSUFFICIENT_BALANCE problem+json', async () => {
    const res = await http()
      .post('/time-off-requests')
      .set('Idempotency-Key', 'k2')
      .send({ employeeId: 'e1', locationId: 'l1', amountDays: 99 })
      .expect(422);
    expect(res.body.title).toBe('INSUFFICIENT_BALANCE');
  });

  it('approve → 200 APPROVED; re-approve → 409 INVALID_TRANSITION', async () => {
    const created = await http()
      .post('/time-off-requests')
      .set('Idempotency-Key', 'k3')
      .send({ employeeId: 'e1', locationId: 'l1', amountDays: 2 })
      .expect(201);
    const id = created.body.id;
    await http()
      .post(`/time-off-requests/${id}/approve`)
      .send({ managerId: 'm1' })
      .expect(200);
    const conflict = await http()
      .post(`/time-off-requests/${id}/approve`)
      .send({ managerId: 'm1' })
      .expect(409);
    expect(conflict.body.title).toBe('INVALID_TRANSITION');
  });

  it('GET /balances/:emp/:loc returns projection with availableDays', async () => {
    const res = await http().get('/balances/e1/l1').expect(200);
    expect(res.body).toMatchObject({
      employeeId: 'e1',
      locationId: 'l1',
      accruedBaseline: 10,
      pendingHolds: 0,
      taken: 0,
      availableDays: 10,
    });
    await http().get('/balances/eX/lX').expect(404);
  });

  it('list filters by status', async () => {
    await http()
      .post('/time-off-requests')
      .set('Idempotency-Key', 'k4')
      .send({ employeeId: 'e1', locationId: 'l1', amountDays: 1 })
      .expect(201);
    const res = await http()
      .get('/time-off-requests?employeeId=e1&status=PENDING')
      .expect(200);
    expect(res.body).toHaveLength(1);
    const none = await http()
      .get('/time-off-requests?employeeId=e1&status=SYNCED')
      .expect(200);
    expect(none.body).toHaveLength(0);
  });

  it('deny over HTTP → 200 DENIED; balance shows pendingHolds 0', async () => {
    const created = await http()
      .post('/time-off-requests')
      .set('Idempotency-Key', 'k5')
      .send({ employeeId: 'e1', locationId: 'l1', amountDays: 3 })
      .expect(201);
    const id = created.body.id;

    const denied = await http()
      .post(`/time-off-requests/${id}/deny`)
      .send({ managerId: 'm1' })
      .expect(200);
    expect(denied.body.status).toBe('DENIED');

    const bal = await http().get('/balances/e1/l1').expect(200);
    expect(bal.body.pendingHolds).toBe(0);
    expect(bal.body.availableDays).toBe(10);
  });

  it('cancel over HTTP → 200 CANCELLED; hold released', async () => {
    const created = await http()
      .post('/time-off-requests')
      .set('Idempotency-Key', 'k6')
      .send({ employeeId: 'e1', locationId: 'l1', amountDays: 4 })
      .expect(201);
    const id = created.body.id;

    const cancelled = await http()
      .post(`/time-off-requests/${id}/cancel`)
      .expect(200);
    expect(cancelled.body.status).toBe('CANCELLED');

    const bal = await http().get('/balances/e1/l1').expect(200);
    expect(bal.body.pendingHolds).toBe(0);
    expect(bal.body.availableDays).toBe(10);
  });

  it('GET /time-off-requests/:id with unknown id → 404 problem+json with NOT_FOUND', async () => {
    const res = await http().get('/time-off-requests/unknown-id').expect(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.title).toBe('NOT_FOUND');
  });
});
