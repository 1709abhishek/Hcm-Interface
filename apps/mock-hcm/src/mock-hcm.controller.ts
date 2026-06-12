import { Controller, Get } from '@nestjs/common';
import { MockHcmService } from './mock-hcm.service';

@Controller()
export class MockHcmController {
  constructor(private readonly mockHcmService: MockHcmService) {}

  @Get()
  getHello(): string {
    return this.mockHcmService.getHello();
  }
}
