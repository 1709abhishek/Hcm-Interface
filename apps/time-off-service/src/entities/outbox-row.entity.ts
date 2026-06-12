import { Column, Entity, PrimaryColumn } from 'typeorm';

export type OutboxStatus = 'PENDING' | 'SENT' | 'VERIFIED' | 'FAILED';

@Entity('outbox')
export class OutboxRow {
  @PrimaryColumn({ type: 'text' }) id: string;
  @Column({ name: 'request_id', type: 'text' }) requestId: string;
  @Column({ type: 'text' }) operation: 'DEDUCT';
  @Column({ type: 'text' }) payload: string; // JSON: {employeeId, locationId, amountDays}
  @Column({ name: 'idempotency_key', type: 'text', unique: true })
  idempotencyKey: string;
  @Column({ type: 'text' }) status: OutboxStatus;
  @Column({ type: 'integer', default: 0 }) attempts: number;
  @Column({ name: 'next_retry_at', type: 'text', nullable: true }) nextRetryAt:
    | string
    | null;
  @Column({ name: 'last_error', type: 'text', nullable: true }) lastError:
    | string
    | null;
  @Column({ name: 'created_at', type: 'text' }) createdAt: string;
}
