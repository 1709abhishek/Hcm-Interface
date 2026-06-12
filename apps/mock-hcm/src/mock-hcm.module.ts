import { Module } from '@nestjs/common';
import { BalanceStoreService } from './balance-store.service';
import { HcmController } from './hcm.controller';
import { AdminController } from './admin.controller';

@Module({
  controllers: [HcmController, AdminController],
  providers: [BalanceStoreService],
  exports: [BalanceStoreService],
})
export class MockHcmModule {}
