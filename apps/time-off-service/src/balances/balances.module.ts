// apps/time-off-service/src/balances/balances.module.ts
import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { BalancesService } from './balances.service';

@Module({ imports: [LedgerModule], providers: [BalancesService], exports: [BalancesService] })
export class BalancesModule {}
