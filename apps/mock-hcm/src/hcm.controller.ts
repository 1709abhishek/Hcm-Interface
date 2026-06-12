import { Body, Controller, Get, HttpException, NotFoundException, Param, Post } from '@nestjs/common';
import { BalanceStoreService } from './balance-store.service';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CHAOS_TIMEOUT_MS = Number(process.env.MOCK_HCM_TIMEOUT_MS ?? 10_000);

@Controller()
export class HcmController {
  constructor(private readonly store: BalanceStoreService) {}

  @Get('balances/:employeeId/:locationId')
  async getBalance(@Param('employeeId') employeeId: string, @Param('locationId') locationId: string) {
    if (this.store.chaosMode === 'timeout') await sleep(CHAOS_TIMEOUT_MS);
    if (this.store.chaosMode === 'error500') throw new HttpException('chaos', 500);
    const balanceDays = this.store.get(employeeId, locationId);
    if (balanceDays === undefined) throw new NotFoundException();
    return { employeeId, locationId, balanceDays };
  }

  @Post('deductions')
  async postDeduction(
    @Body() body: { idempotencyKey: string; employeeId: string; locationId: string; amountDays: number },
  ) {
    switch (this.store.chaosMode) {
      case 'timeout':
        await sleep(CHAOS_TIMEOUT_MS);
        break;
      case 'error500':
        throw new HttpException('chaos', 500);
      case 'silent-failure':
        return { status: 'ok' }; // lies: 2xx without applying
      case 'reject-insufficient':
        throw new HttpException({ code: 'INSUFFICIENT_BALANCE' }, 422);
    }
    const result = this.store.applyDeduction(body.idempotencyKey, body.employeeId, body.locationId, body.amountDays);
    if (result === 'insufficient') throw new HttpException({ code: 'INSUFFICIENT_BALANCE' }, 422);
    if (result === 'unknown-dimensions') throw new HttpException({ code: 'INVALID_DIMENSIONS' }, 422);
    return { status: 'ok' }; // applied or duplicate — idempotent success
  }

  @Get('deductions/:idempotencyKey')
  getDeduction(@Param('idempotencyKey') idempotencyKey: string) {
    if (!this.store.hasDeduction(idempotencyKey)) throw new NotFoundException();
    return { applied: true };
  }

  @Get('batch')
  getBatch() {
    return { balances: this.store.all() };
  }
}
