// apps/time-off-service/src/hcm-sync/hcm-client.spec.ts
import { HcmClient, HcmUnavailableError } from './hcm-client';
import { bootMockHcm, MockHcm } from '../../test/utils';

// Keep the mock's chaos sleep well above the 500ms client timeout but short enough
// that the pending timer doesn't hold the jest process open for ~10s after the suite.
process.env.MOCK_HCM_TIMEOUT_MS = '2000';

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
