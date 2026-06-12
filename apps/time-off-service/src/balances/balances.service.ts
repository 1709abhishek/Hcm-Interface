// apps/time-off-service/src/balances/balances.service.ts
import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { Balance, available } from '../entities/balance.entity';
import { LedgerService } from '../ledger/ledger.service';
import { AppError } from '../common/app-error';
import { DbMutex } from '../common/db-mutex';

export interface BatchEntry {
  employeeId: string;
  locationId: string;
  balanceDays: number;
}
export interface BatchSummary {
  updated: number;
  created: number;
  negative: { employeeId: string; locationId: string; available: number }[];
}

@Injectable()
export class BalancesService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly ledger: LedgerService,
    private readonly mutex: DbMutex,
  ) {}

  async getBalance(employeeId: string, locationId: string): Promise<Balance> {
    const b = await this.dataSource.manager.findOneBy(Balance, {
      employeeId,
      locationId,
    });
    if (!b) throw new AppError('NOT_FOUND', 404);
    return b;
  }

  /** D1 + D4: validate locally, mutate + ledger in one TX (race-free: single serialized SQLite writer). */
  async placeHold(
    employeeId: string,
    locationId: string,
    amountDays: number,
    requestId: string,
  ): Promise<void> {
    await this.mutex.run(() =>
      this.dataSource.transaction((em) =>
        this.placeHoldInTx(em, employeeId, locationId, amountDays, requestId),
      ),
    );
  }

  async placeHoldInTx(
    em: EntityManager,
    employeeId: string,
    locationId: string,
    amountDays: number,
    requestId: string,
  ): Promise<void> {
    const b = await em.findOneBy(Balance, { employeeId, locationId });
    if (!b) throw new AppError('INVALID_DIMENSIONS', 422);
    if (available(b) < amountDays)
      throw new AppError('INSUFFICIENT_BALANCE', 422);
    b.pendingHolds += amountDays;
    await em.save(b);
    await this.ledger.append(em, {
      employeeId,
      locationId,
      entryType: 'HOLD_PLACED',
      amount: -amountDays,
      balanceAfter: available(b),
      requestId,
      detail: null,
    });
  }

  async releaseHold(
    employeeId: string,
    locationId: string,
    amountDays: number,
    requestId: string,
  ): Promise<void> {
    await this.mutex.run(() =>
      this.dataSource.transaction((em) =>
        this.releaseHoldInTx(em, employeeId, locationId, amountDays, requestId),
      ),
    );
  }

  async releaseHoldInTx(
    em: EntityManager,
    employeeId: string,
    locationId: string,
    amountDays: number,
    requestId: string,
  ): Promise<void> {
    const b = await em.findOneByOrFail(Balance, { employeeId, locationId });
    b.pendingHolds -= amountDays;
    await em.save(b);
    await this.ledger.append(em, {
      employeeId,
      locationId,
      entryType: 'HOLD_RELEASED',
      amount: amountDays,
      balanceAfter: available(b),
      requestId,
      detail: null,
    });
  }

  /** Hold → taken. Net delta to available is 0; the entry is the audit record of the confirmed deduction. */
  async confirmDeduction(
    employeeId: string,
    locationId: string,
    amountDays: number,
    requestId: string,
  ): Promise<void> {
    await this.mutex.run(() =>
      this.dataSource.transaction((em) =>
        this.confirmDeductionInTx(
          em,
          employeeId,
          locationId,
          amountDays,
          requestId,
        ),
      ),
    );
  }

  async confirmDeductionInTx(
    em: EntityManager,
    employeeId: string,
    locationId: string,
    amountDays: number,
    requestId: string,
  ): Promise<void> {
    const b = await em.findOneByOrFail(Balance, { employeeId, locationId });
    b.pendingHolds -= amountDays;
    b.taken += amountDays;
    await em.save(b);
    await this.ledger.append(em, {
      employeeId,
      locationId,
      entryType: 'DEDUCTION_CONFIRMED',
      amount: 0,
      balanceAfter: available(b),
      requestId,
      detail: JSON.stringify({ amountDays }),
    });
  }

  /** Hold-aware merge (TRD §7.2): HCM owns the baseline, we own holds/taken. */
  async applyBatch(entries: BatchEntry[]): Promise<BatchSummary> {
    const summary: BatchSummary = { updated: 0, created: 0, negative: [] };
    for (const entry of entries) {
      await this.mutex.run(async () => {
        await this.dataSource.transaction(async (em) => {
          let b = await em.findOneBy(Balance, {
            employeeId: entry.employeeId,
            locationId: entry.locationId,
          });
          if (!b) {
            b = em.create(Balance, {
              employeeId: entry.employeeId,
              locationId: entry.locationId,
              accruedBaseline: 0,
              pendingHolds: 0,
              taken: 0,
              lastSyncedAt: null,
            });
            summary.created += 1;
          } else {
            summary.updated += 1;
          }
          const delta = entry.balanceDays - b.accruedBaseline;
          b.accruedBaseline = entry.balanceDays;
          b.lastSyncedAt = new Date().toISOString();
          await em.save(b);
          if (delta !== 0) {
            await this.ledger.append(em, {
              employeeId: b.employeeId,
              locationId: b.locationId,
              entryType: 'ACCRUAL_SYNC',
              amount: delta,
              balanceAfter: available(b),
              requestId: null,
              detail: JSON.stringify({ newBaseline: entry.balanceDays }),
            });
          }
          if (available(b) < 0) {
            summary.negative.push({
              employeeId: b.employeeId,
              locationId: b.locationId,
              available: available(b),
            });
          }
          // Defensive (TRD §7.2 step 3): if ledger and projection ever disagree, record the
          // discrepancy as RECONCILIATION_ADJUSTMENT so I1 is restored and the drift is visible.
          const drift =
            available(b) -
            (await this.ledger.sumFor(em, b.employeeId, b.locationId));
          if (drift !== 0) {
            await this.ledger.append(em, {
              employeeId: b.employeeId,
              locationId: b.locationId,
              entryType: 'RECONCILIATION_ADJUSTMENT',
              amount: drift,
              balanceAfter: available(b),
              requestId: null,
              detail: JSON.stringify({
                reason: 'unexplained drift during batch sync',
              }),
            });
          }
        });
      });
    }
    return summary;
  }

  /** Drift check for I1; used by reconciliation and the property suite. */
  async ledgerDrift(
    em: EntityManager,
    employeeId: string,
    locationId: string,
  ): Promise<number> {
    const b = await em.findOneByOrFail(Balance, { employeeId, locationId });
    const sum = await this.ledger.sumFor(em, employeeId, locationId);
    return available(b) - sum;
  }
}
