import { Body, Controller, Post } from '@nestjs/common';
import { BalanceStoreService, ChaosMode } from './balance-store.service';

@Controller()
export class AdminController {
  constructor(private readonly store: BalanceStoreService) {}

  @Post('admin/balances')
  seed(
    @Body()
    body: {
      employeeId: string;
      locationId: string;
      balanceDays: number;
    },
  ) {
    this.store.set(body.employeeId, body.locationId, body.balanceDays);
    return { status: 'ok' };
  }

  @Post('chaos/mode')
  setChaos(@Body() body: { mode: ChaosMode }) {
    this.store.chaosMode = body.mode;
    return { status: 'ok' };
  }
}
