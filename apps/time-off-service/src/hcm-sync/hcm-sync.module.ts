// apps/time-off-service/src/hcm-sync/hcm-sync.module.ts
import { Module } from '@nestjs/common';
import { RequestsModule } from '../requests/requests.module';
import { BalancesModule } from '../balances/balances.module';
import { LedgerModule } from '../ledger/ledger.module';
import { HcmClient } from './hcm-client';
import { OutboxDispatcher } from './outbox-dispatcher';
import { ReconciliationService } from './reconciliation.service';
import { SyncController } from './sync.controller';
import { BalancesController } from '../balances/balances.controller';
import { HcmSyncSchedulers } from './schedulers';

const schedulerProviders =
  process.env.NODE_ENV !== 'test' ? [HcmSyncSchedulers] : [];

@Module({
  imports: [RequestsModule, BalancesModule, LedgerModule],
  controllers: [SyncController, BalancesController],
  providers: [
    { provide: HcmClient, useFactory: () => new HcmClient() }, // reads env at construction
    OutboxDispatcher,
    ReconciliationService,
    ...schedulerProviders,
  ],
  exports: [HcmClient, OutboxDispatcher, ReconciliationService],
})
export class HcmSyncModule {}
