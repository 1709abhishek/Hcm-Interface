// apps/time-off-service/src/hcm-sync/outbox-dispatcher.ts
import { Injectable, Logger } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { OutboxRow } from '../entities/outbox-row.entity';
import { HcmClient, HcmUnavailableError, DeductionPayload } from './hcm-client';
import { RequestsService } from '../requests/requests.service';

const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;

@Injectable()
export class OutboxDispatcher {
  private readonly logger = new Logger(OutboxDispatcher.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly client: HcmClient,
    private readonly requests: RequestsService,
  ) {}

  /** One dispatch pass. Tests call this directly; the scheduler calls it on an interval. */
  async processOnce(opts: { ignoreBackoff?: boolean } = {}): Promise<void> {
    const rows = await this.dataSource.manager.findBy(OutboxRow, {
      status: In(['PENDING', 'SENT']),
    });
    const now = Date.now();
    for (const row of rows) {
      if (
        !opts.ignoreBackoff &&
        row.nextRetryAt &&
        new Date(row.nextRetryAt).getTime() > now
      )
        continue;
      try {
        await this.processRow(row);
      } catch (e) {
        this.logger.error(
          `outbox row ${row.id} (requestId=${row.requestId}) threw unexpectedly: ${(e as Error).message}`,
          (e as Error).stack,
        );
      }
    }
  }

  private async processRow(row: OutboxRow): Promise<void> {
    const parsed = JSON.parse(row.payload) as Omit<
      DeductionPayload,
      'idempotencyKey'
    >;
    const payload: DeductionPayload = {
      ...parsed,
      idempotencyKey: row.idempotencyKey,
    };
    try {
      const response = await this.client.postDeduction(payload);
      // D2: never trust the write response alone — verify by idempotency-key lookup.
      const applied = await this.client.hasDeduction(row.idempotencyKey);
      if (applied) return this.succeed(row);
      if (!response.ok) return this.fail(row, response.code); // explicit HCM decision: permanent
      return this.scheduleRetry(row, 'SILENT_FAILURE'); // 2xx but not applied: the lying HCM
    } catch (e) {
      if (e instanceof HcmUnavailableError)
        return this.scheduleRetry(row, e.message);
      throw e;
    }
  }

  private async succeed(row: OutboxRow): Promise<void> {
    await this.requests.markSynced(row.requestId); // confirms deduction (hold → taken) transactionally
    row.status = 'VERIFIED';
    row.lastError = null;
    await this.dataSource.manager.save(row);
  }

  private async fail(row: OutboxRow, reason: string): Promise<void> {
    // markSyncFailed FIRST (request is the anchor): if we crash after this but before row save,
    // the row stays SENT and is re-processed next tick — markSyncFailed will be a no-op (idempotent)
    // and the row will be saved FAILED then. Converges without leaking the hold.
    await this.requests.markSyncFailed(row.requestId, reason); // releases hold, records reason (D5)
    row.status = 'FAILED';
    row.lastError = reason;
    await this.dataSource.manager.save(row);
    this.logger.warn(`outbox ${row.id} failed permanently: ${reason}`);
  }

  private async scheduleRetry(row: OutboxRow, error: string): Promise<void> {
    row.attempts += 1;
    row.lastError = error;
    if (row.attempts >= MAX_ATTEMPTS)
      return this.fail(row, 'RETRIES_EXHAUSTED');
    const backoff = Math.min(
      BASE_BACKOFF_MS * 2 ** row.attempts,
      MAX_BACKOFF_MS,
    );
    const jitter = Math.floor(Math.random() * 250);
    row.status = 'SENT';
    row.nextRetryAt = new Date(Date.now() + backoff + jitter).toISOString();
    await this.dataSource.manager.save(row);
  }
}
