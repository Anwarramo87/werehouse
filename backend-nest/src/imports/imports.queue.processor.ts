import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { ImportsService } from './imports.service';
import { QUEUE_JOBS, QUEUE_NAMES } from '../queues/queue.constants';
import {
  SerializedTenantScope,
  runInCapturedTenant,
} from '../common/tenant/tenant-job-scope';

type ImportQueuePayload = {
  importJobRecordId: string;
  rows: Record<string, string>[];
  tenant?: SerializedTenantScope;
};

@Injectable()
@Processor(QUEUE_NAMES.IMPORTS)
export class ImportsQueueProcessor extends WorkerHost {
  private readonly logger = new Logger(ImportsQueueProcessor.name);

  constructor(
    private readonly importsService: ImportsService,
    @InjectQueue(QUEUE_NAMES.DEAD_LETTER) private readonly deadLetterQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<ImportQueuePayload>) {
    // A worker has no request behind it, so the scope captured at enqueue time
    // has to be restored before any tenant-scoped write happens.
    if (job.name === QUEUE_JOBS.IMPORT_EMPLOYEES) {
      return runInCapturedTenant(job.data.tenant, 'queue:import-employees', () =>
        this.importsService.processEmployeesImportJob(
          job.data.importJobRecordId,
          job.data.rows,
        ),
      );
    }

    if (job.name === QUEUE_JOBS.IMPORT_PRODUCTS) {
      return runInCapturedTenant(job.data.tenant, 'queue:import-products', () =>
        this.importsService.processProductsImportJob(
          job.data.importJobRecordId,
          job.data.rows,
        ),
      );
    }

    throw new Error(`Unsupported imports job: ${job.name}`);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<ImportQueuePayload> | undefined, error: Error) {
    if (!job) return;

    this.logger.error(`Imports job failed: ${job.id}`, error?.stack || error?.message);

    const maxAttempts = Number(job.opts.attempts || 1);
    if (job.attemptsMade >= maxAttempts) {
      await runInCapturedTenant(job.data.tenant, 'queue:import-failed', () =>
        this.importsService.markImportJobFailed(
          job.data.importJobRecordId,
          error?.message || 'Import job failed',
        ),
      );
      await this.deadLetterQueue.add(
        QUEUE_JOBS.DEAD_LETTER,
        {
          sourceQueue: QUEUE_NAMES.IMPORTS,
          sourceJobName: job.name,
          sourceJobId: job.id,
          payload: job.data,
          error: error?.message || 'Import job failed',
          failedAt: new Date().toISOString(),
        },
        { removeOnComplete: 500, removeOnFail: 500 },
      );
    }
  }
}
