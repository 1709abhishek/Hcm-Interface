// apps/time-off-service/src/requests/requests.module.ts
import { Module } from '@nestjs/common';
import { BalancesModule } from '../balances/balances.module';
import { RequestsService } from './requests.service';

@Module({
  imports: [BalancesModule],
  providers: [RequestsService],
  exports: [RequestsService],
})
export class RequestsModule {}
