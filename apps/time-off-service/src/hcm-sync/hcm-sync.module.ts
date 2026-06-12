// apps/time-off-service/src/hcm-sync/hcm-sync.module.ts
import { Module } from '@nestjs/common';
import { RequestsModule } from '../requests/requests.module';
import { BalancesModule } from '../balances/balances.module';
import { LedgerModule } from '../ledger/ledger.module';
import { HcmClient } from './hcm-client';
import { OutboxDispatcher } from './outbox-dispatcher';

@Module({
  imports: [RequestsModule, BalancesModule, LedgerModule],
  providers: [
    { provide: HcmClient, useFactory: () => new HcmClient() }, // reads env at construction
    OutboxDispatcher,
  ],
  exports: [HcmClient, OutboxDispatcher],
})
export class HcmSyncModule {}
