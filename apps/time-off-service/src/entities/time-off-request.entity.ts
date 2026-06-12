import { Column, Entity, PrimaryColumn } from 'typeorm';

export type RequestStatus = 'PENDING' | 'APPROVED' | 'DENIED' | 'CANCELLED' | 'SYNCED' | 'SYNC_FAILED';

@Entity('time_off_requests')
export class TimeOffRequest {
  @PrimaryColumn({ type: 'text' }) id: string;
  @Column({ name: 'employee_id', type: 'text' }) employeeId: string;
  @Column({ name: 'location_id', type: 'text' }) locationId: string;
  @Column({ name: 'amount_days', type: 'real' }) amountDays: number;
  @Column({ type: 'text' }) status: RequestStatus;
  @Column({ name: 'idempotency_key', type: 'text', unique: true }) idempotencyKey: string;
  @Column({ name: 'manager_id', type: 'text', nullable: true }) managerId: string | null;
  @Column({ name: 'failure_reason', type: 'text', nullable: true }) failureReason: string | null;
  @Column({ name: 'created_at', type: 'text' }) createdAt: string;
  @Column({ name: 'updated_at', type: 'text' }) updatedAt: string;
}
