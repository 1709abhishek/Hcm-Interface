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
