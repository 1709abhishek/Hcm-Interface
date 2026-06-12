// apps/time-off-service/src/balances/balances.controller.ts
import { Controller, Get, Param, Query } from '@nestjs/common';
import { BalancesService } from './balances.service';
import { available } from '../entities/balance.entity';
import { HcmClient } from '../hcm-sync/hcm-client';

@Controller('balances')
export class BalancesController {
  constructor(
    private readonly balances: BalancesService,
    private readonly client: HcmClient,
  ) {}

  @Get(':employeeId/:locationId')
  async getBalance(
    @Param('employeeId') employeeId: string,
    @Param('locationId') locationId: string,
    @Query('verify') verify?: string,
  ) {
    const b = await this.balances.getBalance(employeeId, locationId);
    const body: Record<string, unknown> = { ...b, availableDays: available(b) };
    if (verify === 'true') {
      const hcmBalanceDays = await this.client.getBalance(employeeId, locationId);
      body.hcmVerification = { hcmBalanceDays, baselineMatches: hcmBalanceDays === b.accruedBaseline };
    }
    return body;
  }
}
