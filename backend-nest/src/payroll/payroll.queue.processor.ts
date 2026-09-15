import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { CalculatePayrollDto } from './dto/calculate-payroll.dto';
import { PayrollService } from './payroll.service';
import { QUEUE_JOBS, QUEUE_NAMES } from '../queues/queue.constants';
import {
  SerializedTenantScope,
  runInCapturedTenant,
} from '../common/tenant/tenant-job-scope';

type PayrollQueuePayload = {
  payrollRunId: string;
  dto: CalculatePayrollDto;
  userId?: string;
  tenant?: SerializedTenantScope;
};

@Injectable()
@Processor(QUEUE_NAMES.PAYROLL)
export class PayrollQueueProcessor extends WorkerHost {
  private readonly logger = new Logger(PayrollQueueProcessor.name);

  constructor(
    private readonly payrollService: PayrollService,
    @InjectQueue(QUEUE_NAMES.DEAD_LETTER) private readonly deadLetterQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<PayrollQueuePayload>) {
    if (job.name !== QUEUE_JOBS.PAYROLL_CALCULATE) {
      throw new Error(`Unsupported payroll job: ${job.name}`);
    }

    // Nothing established a tenant here -- a worker has no request behind it --
    // so the scope captured when the run was queued has to be restored, or
    // every query in the run fails closed inside the Prisma extension.
    return runInCapturedTenant(job.data.tenant, 'queue:payroll', () =>
      this.payrollService.processPayrollRunJob(job.data),
    );
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<PayrollQueuePayload> | undefined, error: Error) {
    if (!job) return;

    this.logger.error(`Payroll job failed: ${job.id}`, error?.stack || error?.message);

    const maxAttempts = Number(job.opts.attempts || 1);
    if (job.attemptsMade >= maxAttempts) {
      // Same reason as `process`: marking the run failed is itself a
      // tenant-scoped write, and without the scope the failure path fails too,
      // leaving the run stuck at "queued" forever.
      await runInCapturedTenant(job.data.tenant, 'queue:payroll-failed', () =>
        this.payrollService.markPayrollRunFailed(
          job.data.payrollRunId,
          error?.message || 'Payroll job failed',
        ),
      );
      await this.deadLetterQueue.add(
        QUEUE_JOBS.DEAD_LETTER,
        {
          sourceQueue: QUEUE_NAMES.PAYROLL,
          sourceJobName: job.name,
          sourceJobId: job.id,
          payload: job.data,
          error: error?.message || 'Payroll job failed',
          failedAt: new Date().toISOString(),
        },
        { removeOnComplete: 500, removeOnFail: 500 },
      );
    }
  }
}
