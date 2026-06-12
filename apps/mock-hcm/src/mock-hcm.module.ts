import { Module } from '@nestjs/common';
import { MockHcmController } from './mock-hcm.controller';
import { MockHcmService } from './mock-hcm.service';

@Module({
  imports: [],
  controllers: [MockHcmController],
  providers: [MockHcmService],
})
export class MockHcmModule {}
