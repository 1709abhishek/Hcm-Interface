import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('balances')
export class Balance {
  @PrimaryColumn({ name: 'employee_id', type: 'text' }) employeeId: string;
  @PrimaryColumn({ name: 'location_id', type: 'text' }) locationId: string;
  @Column({ name: 'accrued_baseline', type: 'real', default: 0 }) accruedBaseline: number;
  @Column({ name: 'pending_holds', type: 'real', default: 0 }) pendingHolds: number;
  @Column({ type: 'real', default: 0 }) taken: number;
  @Column({ name: 'last_synced_at', type: 'text', nullable: true }) lastSyncedAt: string | null;
}

export function available(b: Balance): number {
  return b.accruedBaseline - b.taken - b.pendingHolds;
}
