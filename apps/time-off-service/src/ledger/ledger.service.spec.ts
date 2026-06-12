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
