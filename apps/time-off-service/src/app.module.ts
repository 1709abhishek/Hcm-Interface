// apps/time-off-service/src/app.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Balance } from './entities/balance.entity';
import { TimeOffRequest } from './entities/time-off-request.entity';
import { LedgerEntry } from './entities/ledger-entry.entity';
import { OutboxRow } from './entities/outbox-row.entity';
import { LedgerModule } from './ledger/ledger.module';
import { BalancesModule } from './balances/balances.module';
import { RequestsModule } from './requests/requests.module';
import { BalancesController } from './balances/balances.controller';
import { RequestsController } from './requests/requests.controller';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: () => ({
        type: 'better-sqlite3',
        database: process.env.DB_PATH ?? 'data/timeoff.sqlite',
        entities: [Balance, TimeOffRequest, LedgerEntry, OutboxRow],
        synchronize: true, // take-home scope; production would use migrations (TRD §12)
      }),
    }),
    LedgerModule,
    BalancesModule,
    RequestsModule,
  ],
  controllers: [BalancesController, RequestsController],
})
export class AppModule {}
