// apps/time-off-service/src/balances/balances.module.ts
import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { BalancesService } from './balances.service';
import { DbMutex } from '../common/db-mutex';

@Module({
  imports: [LedgerModule],
  providers: [DbMutex, BalancesService],
  exports: [DbMutex, BalancesService],
})
export class BalancesModule {}
