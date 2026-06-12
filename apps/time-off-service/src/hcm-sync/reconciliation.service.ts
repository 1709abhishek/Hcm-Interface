// apps/time-off-service/src/hcm-sync/reconciliation.service.ts
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BalancesService, BatchSummary } from '../balances/balances.service';
import { HcmClient } from './hcm-client';
import { LedgerEntry } from '../entities/ledger-entry.entity';
import { TimeOffRequest } from '../entities/time-off-request.entity';
import { Balance, available } from '../entities/balance.entity';

@Injectable()
export class ReconciliationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly balances: BalancesService,
    private readonly client: HcmClient,
  ) {}

  async runBatchSync(): Promise<BatchSummary> {
    const corpus = await this.client.getBatch();
    return this.balances.applyBatch(corpus);
  }

  async driftReport() {
    const adjustments = await this.dataSource.manager.findBy(LedgerEntry, {
      entryType: 'RECONCILIATION_ADJUSTMENT',
    });
    const balances = await this.dataSource.manager.find(Balance);
    const negativeBalances = balances
      .filter((b) => available(b) < 0)
      .map((b) => ({ employeeId: b.employeeId, locationId: b.locationId, available: available(b) }));
    const syncFailedRequests = await this.dataSource.manager.findBy(TimeOffRequest, { status: 'SYNC_FAILED' });
    return { adjustments, negativeBalances, syncFailedRequests };
  }
}
