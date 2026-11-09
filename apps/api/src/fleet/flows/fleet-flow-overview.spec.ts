import { GUARDS_METADATA } from '@nestjs/common/constants';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { REQUIRES_METADATA } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import type { FleetFlowRecord } from './domain/fleet-flow.domain';
import type { FlowJobRow } from './domain/fleet-flow-step.domain';
import { FleetFlowOverviewService } from './fleet-flow-overview.service';
import { FleetFlowsService } from './fleet-flows.service';
import { ProjectFlowOverviewController } from './project-flow-overview.controller';

function flowRecord(over: Partial<FleetFlowRecord> = {}): FleetFlowRecord {
  return {
    id: 'flow-1', projectId: 'p1', repoId: 'repo-1', threadId: null, entry: 'NAX', createdByType: 'USER', createdById: 'u1',
    branch: 'feat/x', specSha: 'a'.repeat(40), setSha: 'a'.repeat(40), pinnedRunnerId: null, reviewerRole: 'reviewer',
    supervisorRole: 'supervisor', costCapUsd: '25.0000', spentUsd: '0.0000', state: 'RUNNING', approvalMode: null,
    approverId: null, approvedAt: null, approvalRequestId: null, stopReason: null, ticketId: null, endedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'), updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    features: [{ id: 'feat-1', flowId: 'flow-1', position: 0, feature: 'f14-min', specPath: 'docs/f14.md',
      dependsOn: [], state: 'RUNNING', currentStep: 'RUN', prNumber: null }],
    ...over,
  };
}

function jobRow(over: Partial<FlowJobRow> = {}): FlowJobRow {
  return { id: 'j1', flowFeatureId: null, flowStep: null, command: 'RUN', state: 'RUNNING', costSpentUsd: '0.0000',
    costCarriedUsd: '0.0000', queuedAt: new Date('2026-01-02T03:04:05.000Z'), finishedAt: null, ...over };
}

/** The overview service over the real flow service, so the project fence is the one under test. */
function setup(over: Partial<FleetFlowRecord> = {}) {
  const row = flowRecord(over);
  const flowRepo = { findById: vi.fn().mockResolvedValue(row), lockById: vi.fn().mockResolvedValue(row) };
  const flows = new FleetFlowsService(flowRepo as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  const repos = { findIdentity: vi.fn(async (id: string) => (id === 'repo-1' ? { provider: 'github', owner: 'nathapp-io', name: 'sandbox' } : null)) };
  const tickets = { findRefsByIds: vi.fn(async () => new Map([['tk1', 'SB-7']])) };
  const steps = { listFlowJobs: vi.fn(async () => ({ jobs: [] as FlowJobRow[], truncated: false })) };
  const service = new FleetFlowOverviewService(flows, repos as never, tickets as never, steps as never);
  return { row, service, flows, flowRepo, repos, tickets, steps };
}

const ctx = { project: { id: 'p1', slug: 'web' } } as never;

describe('fleet flow overview (no database)', () => {
  it('AC-1: a flow of another project is fleet.flows.notFound and reads no jobs', async () => {
    const { service, steps } = setup({ projectId: 'p1' });
    const error: unknown = await service.overview('p2', 'flow-1').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotFoundAppException);
    expect(error).toMatchObject({ status: 404, response: { prefix: 'fleet.flows.notFound' } });
    expect(steps.listFlowJobs).not.toHaveBeenCalled();
  });

  it('AC-2: the repo is the identity the repos service resolves, and null when the repo row is gone', async () => {
    const { service, repos } = setup();
    expect((await service.overview('p1', 'flow-1')).repo).toEqual({ provider: 'github', owner: 'nathapp-io', name: 'sandbox' });
    expect(repos.findIdentity).toHaveBeenCalledWith('repo-1');
    repos.findIdentity.mockResolvedValue(null);
    expect((await service.overview('p1', 'flow-1')).repo).toBeNull();
  });

  it('AC-3: the ticket ref comes from the ticket rows of the project', async () => {
    const { service, tickets } = setup({ ticketId: 'tk1' });
    expect((await service.overview('p1', 'flow-1')).ticketRef).toBe('SB-7');
    expect(tickets.findRefsByIds).toHaveBeenCalledWith('p1', ['tk1']);
  });

  it('AC-4: a flow without a ticket has no ref and reads no ticket rows', async () => {
    const { service, tickets } = setup({ ticketId: null });
    expect((await service.overview('p1', 'flow-1')).ticketRef).toBeNull();
    expect(tickets.findRefsByIds).not.toHaveBeenCalled();
  });

  it('AC-5: the newest 500 jobs are read and the truncation is reported', async () => {
    const { service, steps } = setup();
    steps.listFlowJobs.mockResolvedValue({ jobs: [], truncated: true });
    expect((await service.overview('p1', 'flow-1')).truncated).toBe(true);
    expect(steps.listFlowJobs).toHaveBeenCalledWith('flow-1', 500);
  });

  it('AC-6: a job is named after the flow feature it belongs to, and a job of no feature has none', async () => {
    const { service, steps } = setup();
    steps.listFlowJobs.mockResolvedValue({ jobs: [jobRow({ id: 'j1', flowFeatureId: 'feat-1' }), jobRow({ id: 'j2', flowFeatureId: null })], truncated: false });
    const overview = await service.overview('p1', 'flow-1');
    expect(overview.jobs.map((job) => job.feature)).toEqual(['f14-min', null]);
  });

  it('AC-7: a job carries the total cost, the step and ISO timestamps', async () => {
    const { service, steps } = setup();
    steps.listFlowJobs.mockResolvedValue({
      jobs: [
        jobRow({ id: 'j1', flowStep: 'RUN', costSpentUsd: '0.1100', costCarriedUsd: '0.0020',
          queuedAt: new Date('2026-01-02T03:04:05.000Z'), finishedAt: new Date('2026-01-02T04:00:00.000Z') }),
        jobRow({ id: 'j2', queuedAt: new Date('2026-01-01T00:00:00.000Z'), finishedAt: null }),
      ],
      truncated: false,
    });
    const overview = await service.overview('p1', 'flow-1');
    expect(overview.jobs[0]).toMatchObject({ id: 'j1', costUsd: '0.1120', step: 'RUN',
      queuedAt: '2026-01-02T03:04:05.000Z', finishedAt: '2026-01-02T04:00:00.000Z' });
    expect(overview.jobs[1]).toMatchObject({ id: 'j2', step: null, finishedAt: null, queuedAt: '2026-01-01T00:00:00.000Z' });
  });

  it('AC-8: the unknown-cost count is the count of the returned rows', async () => {
    const { service, steps } = setup();
    steps.listFlowJobs.mockResolvedValue({
      jobs: [jobRow({ id: 'j1', command: 'AGENT', state: 'COMPLETED' }), jobRow({ id: 'j2', command: 'PLAN', state: 'FAILED' })],
      truncated: false,
    });
    expect((await service.overview('p1', 'flow-1')).unknownCostCount).toBe(2);
  });

  it('AC-9: the controller answers the envelope of the service result and declares the read key', async () => {
    const overview = { repo: null, ticketRef: null, jobs: [], truncated: false, unknownCostCount: 0 };
    const service = { overview: vi.fn().mockResolvedValue(overview) };
    const controller = new ProjectFlowOverviewController(service as never);
    const result = await controller.overview('flow-1', ctx);
    expect(service.overview).toHaveBeenCalledWith('p1', 'flow-1');
    expect(result.data).toEqual(overview);
    expect(Reflect.getMetadata(REQUIRES_METADATA, ProjectFlowOverviewController.prototype.overview))
      .toMatchObject({ keys: ['fleet.flow.read'] });
    expect(Reflect.getMetadata(GUARDS_METADATA, ProjectFlowOverviewController)).toEqual([ProjectMembershipGuard, RequiresGuard]);
  });
});
