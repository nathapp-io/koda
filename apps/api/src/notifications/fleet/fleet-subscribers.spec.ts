import { Logger } from '@nestjs/common';
import { FanOutPublisher, OutboxFanOutError } from '../../outbox/fan-out-publisher';
import { noopLastErrors, outboxRecord } from '../../../test/helpers/outbox-record';
import { FleetApprovalRequestedSubscriber } from './fleet-approval-requested.subscriber';
import { FleetBudgetIncidentSubscriber } from './fleet-budget-incident.subscriber';
import { FleetJobOutcomeSubscriber } from './fleet-job-outcome.subscriber';

describe('fleet notification subscribers (S4a §2.4)', () => {
  let registry: FanOutPublisher;
  const writer = { deliver: jest.fn(async () => 1) };
  const eligibility = { findGlobalAdminIds: jest.fn(async () => ['a1', 'a2']) };
  const reader = {
    projectSlug: jest.fn(async () => 'web'),
    approvalContext: jest.fn(async () => ({ status: 'pending', repo: 'acme/app' })),
  };
  const labels = { forPolicy: jest.fn(async () => 'project KODA') };
  let warn: jest.SpyInstance;

  beforeEach(() => {
    registry = new FanOutPublisher(noopLastErrors);
    new FleetJobOutcomeSubscriber(registry, reader as never, writer as never).onModuleInit();
    new FleetApprovalRequestedSubscriber(registry, reader as never, eligibility as never, labels as never, writer as never).onModuleInit();
    new FleetBudgetIncidentSubscriber(registry, eligibility as never, writer as never).onModuleInit();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.clearAllMocks();
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
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await expect(registry.publish(outboxRecord('fleet_job_outcome', outcome))).rejects.toBeInstanceOf(OutboxFanOutError);
  });

  const ask = { approvalId: 'ap1', type: 'nax_bash_escalate', status: 'pending', projectId: 'p1', jobId: 'j1', policyId: null, path: '/web/fleet/approvals?id=ap1' };

  it('bash approval ask -> every global admin, labelled with the repo', async () => {
    await registry.publish(outboxRecord('fleet_approval_requested', ask));
    expect(writer.deliver).toHaveBeenCalledWith([
      expect.objectContaining({ userId: 'a1', kind: 'approval_requested', title: 'Approval needed: bash on acme/app', sourceId: 'ap1' }),
      expect.objectContaining({ userId: 'a2' }),
    ]);
  });

  it('budget override ask -> labelled with the policy scope', async () => {
    reader.approvalContext.mockResolvedValueOnce({ status: 'pending', repo: null });
    await registry.publish(outboxRecord('fleet_approval_requested', { ...ask, type: 'budget_override_required', jobId: null, policyId: 'pol1' }));
    expect(labels.forPolicy).toHaveBeenCalledWith('pol1');
    expect(writer.deliver).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ title: 'Approval needed: budget override on project KODA' })]));
  });

  it('an ask answered or expired before the handler ran -> no notification (D514, #236 backlog)', async () => {
    reader.approvalContext.mockResolvedValueOnce({ status: 'approved', repo: 'acme/app' });
    await registry.publish(outboxRecord('fleet_approval_requested', ask));
    reader.approvalContext.mockResolvedValueOnce(null);
    await registry.publish(outboxRecord('fleet_approval_requested', ask));
    expect(writer.deliver).not.toHaveBeenCalled();
  });

  it('budget incident -> every global admin', async () => {
    await registry.publish(outboxRecord('fleet_budget_incident', { incidentId: 'i1', kind: 'warn', scope: 'global', spentUsd: '5', amountUsd: '10' }));
    expect(writer.deliver).toHaveBeenCalledWith([
      expect.objectContaining({ userId: 'a1', kind: 'budget_warn' }), expect.objectContaining({ userId: 'a2', kind: 'budget_warn' }),
    ]);
  });
});
