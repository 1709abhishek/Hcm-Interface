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

import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { ProblemJsonFilter } from '../src/common/problem-json.filter';

export async function buildTestApp(): Promise<INestApplication> {
  process.env.NODE_ENV = 'test';
  process.env.DB_PATH = ':memory:';
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = mod.createNestApplication();
  app.useGlobalFilters(new ProblemJsonFilter());
  await app.init();
  return app;
}
