// apps/time-off-service/src/hcm-sync/sync.controller.ts
import {
  Controller,
  Get,
  HttpCode,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ReconciliationService } from './reconciliation.service';
import { HcmClient } from './hcm-client';

@Controller()
export class SyncController {
  constructor(
    private readonly reconciliation: ReconciliationService,
    private readonly client: HcmClient,
  ) {}

  @Post('sync/batch')
  @HttpCode(202)
  runBatch() {
    return this.reconciliation.runBatchSync();
  }

  @Get('admin/reconciliation/drift')
  drift() {
    return this.reconciliation.driftReport();
  }

  @Get('health')
  async health() {
    try {
      await this.client.getBatch();
      return { status: 'ok', hcm: 'reachable' };
    } catch {
      throw new ServiceUnavailableException({
        status: 'degraded',
        hcm: 'unreachable',
      });
    }
  }
}
