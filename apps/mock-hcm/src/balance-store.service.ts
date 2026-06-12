import { Injectable } from '@nestjs/common';

export interface HcmBalance {
  employeeId: string;
  locationId: string;
  balanceDays: number;
}
export type ChaosMode =
  | 'healthy'
  | 'timeout'
  | 'error500'
  | 'silent-failure'
  | 'reject-insufficient';
export type DeductionResult =
  | 'applied'
  | 'duplicate'
  | 'insufficient'
  | 'unknown-dimensions';

@Injectable()
export class BalanceStoreService {
  chaosMode: ChaosMode = 'healthy';
  private balances = new Map<string, number>();
  private deductions = new Map<
    string,
    { employeeId: string; locationId: string; amountDays: number }
  >();

  private key(employeeId: string, locationId: string): string {
    return `${employeeId}:${locationId}`;
  }

  set(employeeId: string, locationId: string, balanceDays: number): void {
    this.balances.set(this.key(employeeId, locationId), balanceDays);
  }

  get(employeeId: string, locationId: string): number | undefined {
    return this.balances.get(this.key(employeeId, locationId));
  }

  all(): HcmBalance[] {
    return [...this.balances.entries()].map(([k, balanceDays]) => {
      const [employeeId, locationId] = k.split(':');
      return { employeeId, locationId, balanceDays };
    });
  }

  applyDeduction(
    idempotencyKey: string,
    employeeId: string,
    locationId: string,
    amountDays: number,
  ): DeductionResult {
    if (this.deductions.has(idempotencyKey)) return 'duplicate';
    const current = this.get(employeeId, locationId);
    if (current === undefined) return 'unknown-dimensions';
    if (current < amountDays) return 'insufficient';
    this.balances.set(this.key(employeeId, locationId), current - amountDays);
    this.deductions.set(idempotencyKey, { employeeId, locationId, amountDays });
    return 'applied';
  }

  hasDeduction(idempotencyKey: string): boolean {
    return this.deductions.has(idempotencyKey);
  }

  reset(): void {
    this.balances.clear();
    this.deductions.clear();
    this.chaosMode = 'healthy';
  }
}
