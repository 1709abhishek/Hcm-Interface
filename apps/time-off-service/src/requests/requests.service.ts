// apps/time-off-service/src/requests/requests.service.ts
import { Injectable } from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';
import { randomUUID } from 'crypto';
import { TimeOffRequest } from '../entities/time-off-request.entity';
import { OutboxRow } from '../entities/outbox-row.entity';
import { BalancesService } from '../balances/balances.service';
import { DbMutex } from '../common/db-mutex';
import { nextStatus } from './state-machine';
import { AppError } from '../common/app-error';

export interface SubmitDto { employeeId: string; locationId: string; amountDays: number; }

@Injectable()
export class RequestsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly balances: BalancesService,
    private readonly mutex: DbMutex,
  ) {}

  async submit(dto: SubmitDto, idempotencyKey: string): Promise<TimeOffRequest> {
    if (!idempotencyKey) throw new AppError('VALIDATION_FAILED', 400, 'Idempotency-Key header required');
    if (!(dto.amountDays > 0)) throw new AppError('VALIDATION_FAILED', 400, 'amountDays must be > 0');
    // D3: idempotency-key lookup is a read — no mutex needed
    const existing = await this.findByIdempotencyKey(idempotencyKey);
    if (existing) return existing;

    const id = randomUUID();
    const now = new Date().toISOString();
    try {
      return await this.mutex.run(() =>
        this.dataSource.transaction(async (em) => {
          // placeHoldInTx validates dimensions + sufficiency (D1) and appends HOLD_PLACED
          await this.balances.placeHoldInTx(em, dto.employeeId, dto.locationId, dto.amountDays, id);
          const req = em.create(TimeOffRequest, {
            id, ...dto, status: 'PENDING', idempotencyKey,
            managerId: null, failureReason: null, createdAt: now, updatedAt: now,
          });
          await em.save(req);
          return req;
        }),
      );
    } catch (err) {
      // D3 race: two concurrent callers both passed the pre-check; the second hits the UNIQUE
      // constraint on idempotency_key. The failed transaction already rolled back the hold.
      if (err instanceof QueryFailedError && String((err as any).message).includes('UNIQUE constraint failed')) {
        const existing = await this.findByIdempotencyKey(idempotencyKey);
        if (existing) return existing;
      }
      throw err;
    }
  }

  async approve(id: string, managerId: string): Promise<TimeOffRequest> {
    return this.mutex.run(() =>
      this.dataSource.transaction(async (em) => {
        const req = await em.findOneBy(TimeOffRequest, { id });
        if (!req) throw new AppError('NOT_FOUND', 404);
        req.status = nextStatus(req.status, 'approve');
        req.managerId = managerId;
        req.updatedAt = new Date().toISOString();
        await em.save(req);
        await em.insert(OutboxRow, {
          id: randomUUID(), requestId: req.id, operation: 'DEDUCT',
          payload: JSON.stringify({ employeeId: req.employeeId, locationId: req.locationId, amountDays: req.amountDays }),
          idempotencyKey: `deduct-${req.id}`, status: 'PENDING', attempts: 0,
          nextRetryAt: null, lastError: null, createdAt: req.updatedAt,
        });
        return req;
      }),
    );
  }

  async deny(id: string, managerId: string): Promise<TimeOffRequest> {
    return this.releaseFlow(id, 'deny', managerId);
  }

  async cancel(id: string): Promise<TimeOffRequest> {
    return this.releaseFlow(id, 'cancel', null);
  }

  private async releaseFlow(id: string, action: 'deny' | 'cancel', managerId: string | null): Promise<TimeOffRequest> {
    return this.mutex.run(() =>
      this.dataSource.transaction(async (em) => {
        const req = await em.findOneBy(TimeOffRequest, { id });
        if (!req) throw new AppError('NOT_FOUND', 404);
        req.status = nextStatus(req.status, action);
        if (managerId) req.managerId = managerId;
        req.updatedAt = new Date().toISOString();
        await em.save(req);
        await this.balances.releaseHoldInTx(em, req.employeeId, req.locationId, req.amountDays, req.id);
        return req;
      }),
    );
  }

  /** Called by the outbox dispatcher after verified HCM success. */
  async markSynced(id: string): Promise<void> {
    await this.mutex.run(() =>
      this.dataSource.transaction(async (em) => {
        const req = await em.findOneBy(TimeOffRequest, { id });
        if (!req) throw new AppError('NOT_FOUND', 404);
        // Idempotency: if already SYNCED (crash-recovery re-run), skip all mutations.
        if (req.status === 'SYNCED') return;
        req.status = nextStatus(req.status, 'syncSucceed');
        req.updatedAt = new Date().toISOString();
        await em.save(req);
        await this.balances.confirmDeductionInTx(em, req.employeeId, req.locationId, req.amountDays, req.id);
      }),
    );
  }

  /** Called by the dispatcher on permanent failure: release the hold, keep the audit trail (D5). */
  async markSyncFailed(id: string, reason: string): Promise<void> {
    await this.mutex.run(() =>
      this.dataSource.transaction(async (em) => {
        const req = await em.findOneBy(TimeOffRequest, { id });
        if (!req) throw new AppError('NOT_FOUND', 404);
        // Idempotency: if already SYNC_FAILED (crash-recovery re-run), skip all mutations.
        if (req.status === 'SYNC_FAILED') return;
        req.status = nextStatus(req.status, 'syncFail');
        req.failureReason = reason;
        req.updatedAt = new Date().toISOString();
        await em.save(req);
        await this.balances.releaseHoldInTx(em, req.employeeId, req.locationId, req.amountDays, req.id);
      }),
    );
  }

  async getById(id: string): Promise<TimeOffRequest> {
    const req = await this.dataSource.manager.findOneBy(TimeOffRequest, { id });
    if (!req) throw new AppError('NOT_FOUND', 404);
    return req;
  }

  async findByIdempotencyKey(key: string): Promise<TimeOffRequest | null> {
    return this.dataSource.manager.findOneBy(TimeOffRequest, { idempotencyKey: key });
  }

  async list(filter: { employeeId?: string; locationId?: string; status?: string }): Promise<TimeOffRequest[]> {
    const where: Record<string, string> = {};
    if (filter.employeeId) where.employeeId = filter.employeeId;
    if (filter.locationId) where.locationId = filter.locationId;
    if (filter.status) where.status = filter.status;
    return this.dataSource.manager.find(TimeOffRequest, { where, order: { createdAt: 'DESC' } });
  }
}
