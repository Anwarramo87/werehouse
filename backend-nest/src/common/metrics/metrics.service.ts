import { Injectable } from '@nestjs/common';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly httpRequestDuration = new Histogram({
    name: 'http_request_duration_ms',
    help: 'HTTP request duration in milliseconds',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [10, 50, 100, 200, 500, 1000, 2000, 5000],
    registers: [this.registry],
  });

  readonly httpErrorsTotal = new Counter({
    name: 'http_errors_total',
    help: 'Total number of HTTP errors (4xx + 5xx)',
    labelNames: ['method', 'route', 'status_code'],
    registers: [this.registry],
  });

  readonly dbSlowQueriesTotal = new Counter({
    name: 'db_slow_queries_total',
    help: 'Total number of slow database queries',
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: 'hrm_' });
  }

  getMetrics(): Promise<string> {
    return this.registry.metrics();
  }
}
