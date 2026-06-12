import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { LedgerEntry, LedgerEntryType } from '../entities/ledger-entry.entity';

export interface LedgerInput {
  employeeId: string;
  locationId: string;
  entryType: LedgerEntryType;
  amount: number;
  balanceAfter: number;
  requestId: string | null;
  detail: string | null;
}

@Injectable()
export class LedgerService {
  /** Must be called inside the same transaction as the balance mutation it records. */
  async append(em: EntityManager, input: LedgerInput): Promise<void> {
    await em.insert(LedgerEntry, { ...input, createdAt: new Date().toISOString() });
  }

  async sumFor(em: EntityManager, employeeId: string, locationId: string): Promise<number> {
    const row = await em
      .createQueryBuilder(LedgerEntry, 'l')
      .select('COALESCE(SUM(l.amount), 0)', 'total')
      .where('l.employee_id = :employeeId AND l.location_id = :locationId', { employeeId, locationId })
      .getRawOne<{ total: number }>();
    return Number(row?.total ?? 0);
  }
}
