import { GUARDS_METADATA } from '@nestjs/common/constants';
import { FleetFlowsService } from './fleet-flows.service';
import { FleetFlowsController } from './fleet-flows.controller';
import { FleetFlowDto } from './dto/fleet-flow.dto';
import type { FleetFlowRecord } from './domain/fleet-flow.domain';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import { FlowRouteCommands } from './flow-route.commands';
import { RequiresGuard } from '../../permissions/requires.guard';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';

function record(over: Partial<FleetFlowRecord> = {}): FleetFlowRecord {
  return { id: 'flow', projectId: 'project', repoId: 'repo', threadId: null, entry: 'NAX', createdByType: 'USER', createdById: 'user',
    branch: 'feat/x', specSha: 'a'.repeat(40), pinnedRunnerId: null, reviewerRole: 'reviewer', supervisorRole: 'supervisor', costCapUsd: '25.0000', spentUsd: '0.0000',
    state: 'PENDING', approvalMode: null, approverId: null, approvedAt: null, approvalRequestId: 'start-ask', stopReason: null, endedAt: null,
    createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'), features: [1, 0].map((position) => ({ id: `f${position}`, flowId: 'flow', position,
      feature: `feature-${position}`, specPath: `${position}.md`, dependsOn: [], state: 'PENDING', currentStep: null, prNumber: null })), ...over };
}
function setup(over: Partial<FleetFlowRecord> = {}) {
  const row = record(over);
  const calls: string[] = [];
  const flows = { findById: vi.fn().mockResolvedValue(row), lockById: vi.fn(async () => { calls.push('flow'); return row; }),
    findPage: vi.fn().mockResolvedValue({ records: [row], total: 1, current: 1, size: 20, hasNext: false, hasPrev: false }),
    stop: vi.fn(async (_id: string, reason: string, now: Date) => { calls.push('stop'); return { ...row, state: 'STOPPED', stopReason: reason, endedAt: now }; }) };
  const threads = { lockForFlowTransition: vi.fn(async () => { calls.push('thread'); return { id: 'thread' }; }) };
  const repos = { lockById: vi.fn(async () => { calls.push('repo'); return { id: 'repo' }; }) };
  const asks = { close: vi.fn(async () => { calls.push('close'); return null; }) };
  const audit = { record: vi.fn() };
  const activity = { record: vi.fn() };
  const tx = { run: vi.fn(async (fn: () => Promise<unknown>) => { calls.push('tx'); return fn(); }) };
  const service = new FleetFlowsService(flows as never, threads as never, repos as never, asks as never, audit as never, activity as never, tx as never);
  return { row, calls, flows, threads, repos, asks, audit, activity, tx, service };
}
const creator = { type: 'AGENT', id: 'agent' } as const;
const principal = { actorType: 'agent', id: 'agent' } as const;
const ctx = { project: { id: 'project', slug: 'web' } } as never;

async function projectController(service: FleetFlowsService, gate = { run: vi.fn() }) {
  const { ProjectFlowsController } = await import('./project-flows.controller');
  return { controller: new ProjectFlowsController(service, gate as never), gate, ProjectFlowsController };
}
function globalController(service: FleetFlowsService) {
  const projects = { findAllForPrincipal: vi.fn().mockResolvedValue([{ id: 'project', slug: 'web' }]) };
  const permissions = { can: vi.fn().mockResolvedValue({ allowed: true }) };
  const controller = new FleetFlowsController({} as never, projects as never, permissions as never, {} as never, {} as never, service);
  return { controller, projects, permissions };
}

describe('fleet flow read and stop (no database)', () => {
  it('AC-1: lists by project through the repository page and maps the shared envelope', async () => {
    const { service, flows } = setup();
    const { controller } = await projectController(service);
    const result = await controller.list({ current: 2, size: 1 }, ctx);
    expect(flows.findPage).toHaveBeenCalledWith({ projectId: 'project' }, { current: 2, size: 1 });
    expect(result.data).toMatchObject({ records: [{ id: 'flow', url: '/web/flows/flow' }], total: 1 });
  });
  it('AC-2: detail returns a complete DTO with position-ordered features and decimal strings', async () => {
    const { service, row } = setup();
    const { controller } = await projectController(service);
    const result = await controller.get('flow', ctx);
    expect(result.data).toEqual(FleetFlowDto.from(row, 'web'));
    const dto = result.data;
    if (Array.isArray(dto)) throw new Error('detail returned an array');
    expect(dto.features.map((feature) => feature.feature)).toEqual(['feature-0', 'feature-1']);
    expect(typeof dto.costCapUsd).toBe('string');
  });
  it('AC-3: project mismatch is fleet.flows.notFound', async () => {
    const { service } = setup({ projectId: 'other' });
    await expect(service.get('project', 'flow')).rejects.toMatchObject({ status: 404, response: { prefix: 'fleet.flows.notFound' } });
  });
  it('AC-4: global detail resolves project visibility and enforces the read in that project', async () => {
    const { service, row } = setup();
    const { controller, permissions } = globalController(service);
    expect((await controller.get('flow', principal as never)).data).toEqual(FleetFlowDto.from(row, 'web'));
    expect(permissions.can).toHaveBeenCalledWith(principal, 'fleet.flow.read', { projectId: 'project' });
  });
  it('AC-5: unrostered agent sees the same notFound and no permission probe', async () => {
    const { service } = setup();
    const { controller, projects, permissions } = globalController(service);
    projects.findAllForPrincipal.mockResolvedValue([]);
    await expect(controller.get('flow', principal as never)).rejects.toMatchObject({ status: 404, response: { prefix: 'fleet.flows.notFound' } });
    expect(permissions.can).not.toHaveBeenCalled();
  });
  it('AC-6/12: project read and stop are membership-then-permission guarded', async () => {
    const { ProjectFlowsController } = await projectController(setup().service);
    expect(Reflect.getMetadata(GUARDS_METADATA, ProjectFlowsController)).toEqual([ProjectMembershipGuard, RequiresGuard]);
  });
  it.each(['PENDING', 'APPROVED'] as const)('AC-7/9/11: stops %s with human_stop and records audit/activity inside one transaction', async (state) => {
    const { service, tx, audit, activity } = setup({ state });
    const now = new Date('2026-02-01');
    expect(await service.stop('project', 'flow', creator, now)).toMatchObject({ state: 'STOPPED', stopReason: 'human_stop', endedAt: now });
    expect(tx.run).toHaveBeenCalledOnce();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ key: 'fleet.flow.stop', resourceType: 'flow', resourceId: 'flow', projectId: 'project' }));
    expect(activity.record).toHaveBeenCalledWith({ actorType: 'AGENT', actorId: 'agent', action: 'flow.stopped', entityType: 'flow', entityId: 'flow', projectId: 'project', payload: { flowId: 'flow', stopReason: 'human_stop' } });
  });
  it('AC-8: lock repo then flow then close; skip-locked null is not fatal', async () => {
    const { service, asks, calls } = setup();
    await service.stop('project', 'flow', creator);
    expect(calls).toEqual(['tx', 'repo', 'flow', 'stop', 'close']);
    expect(asks.close).toHaveBeenCalledWith('start-ask', { status: 'cancelled', reason: 'flow_stopped' }, expect.any(Date));
  });
  it('thread stop uses an unguarded thread owner lock, not entry eligibility', async () => {
    const { service, calls, threads, repos } = setup({ entry: 'THREAD', threadId: 'thread' });
    await service.stop('project', 'flow', creator);
    expect(calls).toEqual(['tx', 'thread', 'flow', 'stop', 'close']);
    expect(threads.lockForFlowTransition).toHaveBeenCalledWith('project', 'thread');
    expect(repos.lockById).not.toHaveBeenCalled();
  });
  it.each(['STOPPED', 'COMPLETED'] as const)('AC-10/14: refuses %s read under the lock with no writes', async (state) => {
    const { service, flows, asks, audit } = setup();
    flows.lockById.mockResolvedValue(record({ state }));
    await expect(service.stop('project', 'flow', creator)).rejects.toMatchObject({ status: 409, response: { prefix: 'fleet.flows.notStoppable' } });
    expect(flows.stop).not.toHaveBeenCalled();
    expect(asks.close).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
  it('AC-13: asked stop returns pending without calling service; registered command later stops as the agent', async () => {
    const { service, flows } = setup();
    const gate = { run: vi.fn().mockResolvedValue({ status: 'pending', request: { id: 'stop-ask' } }) };
    const { controller } = await projectController(service, gate);
    await expect(controller.stop('flow', ctx)).rejects.toMatchObject({ request: { id: 'stop-ask' } });
    expect(flows.stop).not.toHaveBeenCalled();
    expect(gate.run).toHaveBeenCalledWith({ key: 'fleet.flow.stop', variant: 'rest:fleet-flow.stop', projectId: 'project', input: { projectId: 'project', flowId: 'flow' } });
    const registry = new ApprovalCommandRegistry();
    new FlowRouteCommands(registry, {} as never, { forContext: vi.fn().mockResolvedValue(principal) } as never, service).onModuleInit();
    const command = registry.get('fleet.flow.stop', 'rest:fleet-flow.stop');
    expect(command).toBeDefined();
    if (!command) throw new Error('stop command not registered');
    await command.execute(command.parse({ projectId: 'project', flowId: 'flow' }));
    expect(flows.stop).toHaveBeenCalledWith('flow', 'human_stop', expect.any(Date));
  });
  it('stop returns the shared DTO when the gate executes immediately', async () => {
    const { service, row } = setup();
    const gate = { run: vi.fn().mockResolvedValue({ status: 'executed', result: { ...row, state: 'STOPPED', stopReason: 'human_stop' } }) };
    const { controller } = await projectController(service, gate);
    expect((await controller.stop('flow', ctx)).data).toMatchObject({ id: 'flow', state: 'STOPPED', stopReason: 'human_stop' });
  });
  it('AC-15: missing IDs and project mismatch return notFound, including the locked re-read', async () => {
    const { service, flows } = setup();
    flows.findById.mockResolvedValue(null);
    await expect(service.get('project', 'missing')).rejects.toMatchObject({ status: 404 });
    await expect(service.stop('project', 'missing', creator)).rejects.toMatchObject({ status: 404 });
    await expect(globalController(service).controller.get('missing', principal as never)).rejects.toMatchObject({ status: 404 });
    flows.findById.mockResolvedValue(record({ projectId: 'other' }));
    await expect(service.stop('project', 'flow', creator)).rejects.toMatchObject({ status: 404 });
    flows.findById.mockResolvedValue(record());
    flows.lockById.mockResolvedValue(null as never);
    await expect(service.stop('project', 'flow', creator)).rejects.toMatchObject({ status: 404 });
    expect(flows.stop).not.toHaveBeenCalled();
  });
  it('global reachable project without the read key is 403', async () => {
    const { controller, permissions } = globalController(setup().service);
    permissions.can.mockResolvedValue({ allowed: false });
    await expect(controller.get('flow', principal as never)).rejects.toMatchObject({ status: 403 });
  });
});
