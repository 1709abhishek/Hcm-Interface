// apps/time-off-service/src/balances/balances.controller.ts
import { Controller, Get, Param } from '@nestjs/common';
import { BalancesService } from './balances.service';
import { available } from '../entities/balance.entity';

@Controller('balances')
export class BalancesController {
  constructor(private readonly balances: BalancesService) {}

  @Get(':employeeId/:locationId')
  async getBalance(@Param('employeeId') employeeId: string, @Param('locationId') locationId: string) {
    const b = await this.balances.getBalance(employeeId, locationId);
    return { ...b, availableDays: available(b) };
  }
}
