import { Injectable } from '@nestjs/common';
import { Cron, Interval } from '@nestjs/schedule';
import { OutboxDispatcher } from './outbox-dispatcher';
import { ReconciliationService } from './reconciliation.service';

@Injectable()
export class HcmSyncSchedulers {
  constructor(
    private readonly dispatcher: OutboxDispatcher,
    private readonly reconciliation: ReconciliationService,
  ) {}

  @Interval(2000)
  dispatchTick() {
    return this.dispatcher.processOnce();
  }

  @Cron('0 2 * * *') // nightly batch reconciliation
  nightlyBatch() {
    return this.reconciliation.runBatchSync();
  }
}
