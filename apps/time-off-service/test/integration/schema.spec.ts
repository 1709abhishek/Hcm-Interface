import { createTestDataSource } from '../utils';

describe('schema', () => {
  it('synchronizes all four entities into in-memory SQLite', async () => {
    const ds = await createTestDataSource();
    const tables = await ds.query(`SELECT name FROM sqlite_master WHERE type='table'`);
    const names = tables.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(['balances', 'time_off_requests', 'ledger', 'outbox']));
    await ds.destroy();
  });
});
