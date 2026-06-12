import { DataSource } from 'typeorm';
import { Balance } from '../src/entities/balance.entity';
import { TimeOffRequest } from '../src/entities/time-off-request.entity';
import { LedgerEntry } from '../src/entities/ledger-entry.entity';
import { OutboxRow } from '../src/entities/outbox-row.entity';

export const ALL_ENTITIES = [Balance, TimeOffRequest, LedgerEntry, OutboxRow];

export async function createTestDataSource(): Promise<DataSource> {
  const ds = new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    entities: ALL_ENTITIES,
    synchronize: true,
  });
  await ds.initialize();
  return ds;
}

export const nowIso = () => new Date().toISOString();
