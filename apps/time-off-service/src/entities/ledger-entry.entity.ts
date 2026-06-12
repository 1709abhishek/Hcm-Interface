import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type LedgerEntryType =
  | 'HOLD_PLACED' | 'HOLD_RELEASED' | 'DEDUCTION_CONFIRMED'
  | 'ACCRUAL_SYNC' | 'RECONCILIATION_ADJUSTMENT';

@Entity('ledger')
export class LedgerEntry {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'employee_id', type: 'text' }) employeeId: string;
  @Column({ name: 'location_id', type: 'text' }) locationId: string;
  @Column({ name: 'entry_type', type: 'text' }) entryType: LedgerEntryType;
  @Column({ type: 'real' }) amount: number;            // signed delta to `available`
  @Column({ name: 'balance_after', type: 'real' }) balanceAfter: number;
  @Column({ name: 'request_id', type: 'text', nullable: true }) requestId: string | null;
  @Column({ type: 'text', nullable: true }) detail: string | null;
  @Column({ name: 'created_at', type: 'text' }) createdAt: string;
}
