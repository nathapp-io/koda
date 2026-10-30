import type { MockInstance } from 'vitest';
import { Logger } from '@nestjs/common';
import { FanOutPublisher, OutboxFanOutError } from '../../outbox/fan-out-publisher';
import { noopLastErrors, outboxRecord } from '../../../test/helpers/outbox-record';
import { FleetBudgetIncidentSubscriber } from './fleet-budget-incident.subscriber';
import { FleetJobOutcomeSubscriber } from './fleet-job-outcome.subscriber';

describe('fleet notification subscribers (S4a §2.4)', () => {
  let registry: FanOutPublisher;
  const writer = { deliver: vi.fn(async () => 1) };
  const eligibility = { findGlobalAdminIds: vi.fn(async () => ['a1', 'a2']) };
  const reader = { projectSlug: vi.fn(async () => 'web') };
  let warn: MockInstance;

  beforeEach(() => {
    registry = new FanOutPublisher(noopLastErrors);
    new FleetJobOutcomeSubscriber(registry, reader as never, writer as never).onModuleInit();
    new FleetBudgetIncidentSubscriber(registry, eligibility as never, writer as never).onModuleInit();
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.clearAllMocks();
    warn.mockRestore();
  });

  const outcome = { jobId: 'j1', leaseEpoch: 1, projectId: 'p1', requestedById: 'u1', outcome: 'failed', repo: 'acme/app', feature: 'f', resultPrUrl: null };

  it('job outcome -> one draft for the requester', async () => {
    await registry.publish(outboxRecord('fleet_job_outcome', outcome));
    expect(writer.deliver).toHaveBeenCalledWith([expect.objectContaining({ userId: 'u1', kind: 'job_failed', link: '/web/fleet/jobs/j1', sourceId: 'j1:1' })]);
  });

  it('job outcome of a deleted project -> nothing, no retry', async () => {
    reader.projectSlug.mockResolvedValueOnce(null);
    await expect(registry.publish(outboxRecord('fleet_job_outcome', outcome))).resolves.toBeUndefined();
    expect(writer.deliver).not.toHaveBeenCalled();
  });

  it('a malformed payload is logged and skipped, never retried', async () => {
    await expect(registry.publish(outboxRecord('fleet_job_outcome', { jobId: 'j1' }))).resolves.toBeUndefined();
    await expect(registry.publish(outboxRecord('fleet_budget_incident', 'garbage'))).resolves.toBeUndefined();
    expect(writer.deliver).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('a database failure throws so the outbox retries', async () => {
    writer.deliver.mockRejectedValueOnce(new Error('db down'));
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await expect(registry.publish(outboxRecord('fleet_job_outcome', outcome))).rejects.toBeInstanceOf(OutboxFanOutError);
  });

  it('budget incident -> every global admin', async () => {
    await registry.publish(outboxRecord('fleet_budget_incident', { incidentId: 'i1', kind: 'warn', scope: 'global', spentUsd: '5', amountUsd: '10' }));
    expect(writer.deliver).toHaveBeenCalledWith([
      expect.objectContaining({ userId: 'a1', kind: 'budget_warn' }), expect.objectContaining({ userId: 'a2', kind: 'budget_warn' }),
    ]);
  });
});
