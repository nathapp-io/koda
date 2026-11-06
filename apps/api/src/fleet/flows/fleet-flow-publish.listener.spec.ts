import { createMock } from '@golevelup/ts-vitest';
import type { ITransactionManager } from '@nathapp/nestjs-data';
import { currentContext, runWithActionContext } from '../../action-context/action-context';
import { ApprovalAskService } from '../../approvals/approval-ask.service';
import { AuditRecorder } from '../../audit/audit-recorder.service';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { FleetReposService } from '../repos/fleet-repos.service';
import { ThreadsService } from '../threads/threads.service';
import type { ChatThreadRecord } from '../threads/domain/chat-thread.domain';
import type { FleetFlowRecord, IFleetFlowRepository } from './domain/fleet-flow.domain';
import { FleetFlowsService } from './fleet-flows.service';
import { FleetFlowStartCommand } from './fleet-flow-start.command';

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const PATH = 'docs/spec.md';

function setup(state: FleetFlowRecord['state'] = 'PENDING') {
  let row: FleetFlowRecord = {
    id: 'F', projectId: 'P', repoId: 'R', threadId: 'T', entry: 'THREAD', createdByType: 'AGENT', createdById: 'author',
    branch: 'feat/flow', specSha: OLD, pinnedRunnerId: 'runner', reviewerRole: 'reviewer', supervisorRole: 'supervisor',
    costCapUsd: '25', spentUsd: '0', state, approvalMode: state === 'APPROVED' ? 'REQUEST' : null,
    approverId: state === 'APPROVED' ? 'human' : null, approvedAt: state === 'APPROVED' ? new Date(0) : null,
    approvalRequestId: 'old', stopReason: null, endedAt: null, createdAt: new Date(0), updatedAt: new Date(0),
    features: [{ id: 'feature', flowId: 'F', position: 0, feature: 'flow', specPath: PATH, dependsOn: [], state: 'PENDING', currentStep: null, prNumber: null }],
  };
  const order: string[] = [];
  const flows = createMock<IFleetFlowRepository>();
  flows.findLiveForThread.mockImplementation(async () => row);
  flows.lockById.mockImplementation(async () => { order.push('flow'); return row; });
  flows.reask.mockImplementation(async (_id, data) => {
    row = { ...row, ...data, state: 'PENDING', approvalMode: null, approverId: null, approvedAt: null }; return row;
  });
  flows.updateSha.mockImplementation(async (_id, specSha) => { row = { ...row, specSha }; return row; });
  const threads = createMock<ThreadsService>();
  threads.lockForFlowTransition.mockImplementation(async () => {
    order.push('thread'); return { id: 'T', projectId: 'P', publishedSha: NEW } as ChatThreadRecord;
  });
  const asks = createMock<ApprovalAskService>();
  asks.open.mockResolvedValue({ status: 'pending', request: { id: 'new' } } as never);
  asks.close.mockImplementation(async () => { order.push('request'); return null; });
  const audit = createMock<AuditRecorder>();
  const activity = createMock<FleetActivityService>();
  const tx = createMock<ITransactionManager>({ run: vi.fn((fn) => fn()) });
  const service = new FleetFlowsService(flows, threads, createMock<FleetReposService>(), asks, audit, activity, tx);
  return { service, flows, threads, asks, audit, activity, order, row: () => row };
}

describe('FleetFlowPublishListener / respec', () => {
  // Deliberately import at call time so the pre-implementation failure names the missing listener.
  const deliver = async (s: ReturnType<typeof setup>, paths = [PATH], sha = NEW, previousSha: string | null = OLD) => {
    const { FleetFlowPublishListener } = await import('./fleet-flow-publish.listener');
    return new FleetFlowPublishListener(s.service).onThreadSpecPublished({ threadId: 'T', sha, paths, previousSha });
  };

  it('AC-3/10/11: touched APPROVED flow re-asks under the system writer with audit and activity', async () => {
    const s = setup('APPROVED');
    s.audit.record.mockImplementation(async () => { expect(currentContext()?.actor).toEqual({ type: 'SYSTEM', id: 'flow' }); });
    await deliver(s);
    expect(s.order).toEqual(['thread', 'flow', 'request']);
    expect(s.row()).toMatchObject({ state: 'PENDING', specSha: NEW, approvalMode: null, approverId: null, approvedAt: null, approvalRequestId: 'new' });
    expect(s.audit.record).toHaveBeenCalledWith(expect.objectContaining({ key: 'system.flow.respec', resourceType: 'flow', resourceId: 'F', projectId: 'P' }));
    expect(s.activity.record).toHaveBeenCalledWith({ actorType: 'SYSTEM', actorId: 'flow', action: 'flow.respec', entityType: 'flow', entityId: 'F', projectId: 'P', payload: { flowId: 'F', state: 'PENDING' } });
  });

  it.each([[PATH], ['docs/unrelated.md']])('AC-4/5: PENDING always re-asks, paths %s', async (path) => {
    const s = setup();
    await deliver(s, [path]);
    expect(s.asks.close).toHaveBeenCalledWith('old', { status: 'cancelled', reason: 'superseded' }, expect.any(Date));
    expect(s.asks.open).toHaveBeenCalledWith({ key: 'fleet.flow.start', projectId: 'P', component: 'flow', origin: 'system', onBehalfOf: { type: 'AGENT', id: 'author' }, deadline: null, input: { flowId: 'F', specSha: NEW } }, expect.any(Date));
    expect(s.row()).toMatchObject({ state: 'PENDING', specSha: NEW, approvalRequestId: 'new' });
  });

  it('AC-6: untouched APPROVED only updates sha and preserves approval', async () => {
    const s = setup('APPROVED');
    const before = s.row();
    await deliver(s, ['docs/unrelated.md']);
    expect(s.row()).toEqual({ ...before, specSha: NEW });
    expect(s.asks.open).not.toHaveBeenCalled();
    expect(s.asks.close).not.toHaveBeenCalled();
    expect(s.audit.record).toHaveBeenCalledOnce();
    expect(s.activity.record).toHaveBeenCalledWith(expect.objectContaining({ payload: { flowId: 'F', state: 'APPROVED' } }));
  });

  it.each([null, 'c'.repeat(40)])('F1: an unproven or skipped predecessor %s re-asks even without a touched spec', async (previousSha) => {
    const s = setup('APPROVED');
    await deliver(s, ['docs/other.md'], NEW, previousSha);
    expect(s.row()).toMatchObject({ state: 'PENDING', specSha: NEW, approvalMode: null, approverId: null, approvedAt: null });
    expect(s.asks.open).toHaveBeenCalledOnce();
    expect(s.flows.updateSha).not.toHaveBeenCalled();
  });

  it('AC-7: stale publication changes nothing', async () => {
    const s = setup();
    await deliver(s, [PATH], 'c'.repeat(40));
    expect(s.flows.reask).not.toHaveBeenCalled();
    expect(s.flows.updateSha).not.toHaveBeenCalled();
    expect(s.asks.open).not.toHaveBeenCalled();
    expect(s.audit.record).not.toHaveBeenCalled();
    expect(s.activity.record).not.toHaveBeenCalled();
  });

  it('AC-8: duplicate publication changes once', async () => {
    const s = setup();
    await deliver(s);
    await deliver(s);
    expect(s.asks.open).toHaveBeenCalledOnce();
    expect(s.flows.reask).toHaveBeenCalledOnce();
    expect(s.audit.record).toHaveBeenCalledOnce();
    expect(s.activity.record).toHaveBeenCalledOnce();
  });

  it('AC-9: no live flow is a quiet no-op', async () => {
    const s = setup();
    s.flows.findLiveForThread.mockResolvedValue(null);
    await deliver(s);
    expect(s.threads.lockForFlowTransition).not.toHaveBeenCalled();
    expect(s.asks.open).not.toHaveBeenCalled();
    expect(s.audit.record).not.toHaveBeenCalled();
    expect(s.activity.record).not.toHaveBeenCalled();
  });

  it('AC-12: a late approval holding the superseded request cannot approve the re-asked flow', async () => {
    const s = setup();
    await deliver(s); // close returned null: a concurrent decider may hold old request
    const start = new FleetFlowStartCommand(s.flows, s.audit, s.activity);
    const result = await runWithActionContext({ actor: { type: 'USER', id: 'human' }, origin: 'rest', approval: { requiredMode: 'human', satisfiedBy: 'human', requestId: 'old', approverId: 'human' } }, () => start.execute({ flowId: 'F', specSha: OLD }));
    expect(result).toEqual({ applied: false });
    expect(s.row().state).toBe('PENDING');
    expect(s.flows.approve).not.toHaveBeenCalled();
  });

  it.each(['RUNNING', 'WAITING_MERGE', 'WAITING_ANSWER', 'STOPPED', 'COMPLETED'] as const)('leaves locked later/terminal state %s to F3', async (state) => {
    const s = setup(state);
    await deliver(s);
    expect(s.asks.open).not.toHaveBeenCalled();
    expect(s.flows.reask).not.toHaveBeenCalled();
    expect(s.flows.updateSha).not.toHaveBeenCalled();
    expect(s.audit.record).not.toHaveBeenCalled();
  });

  it('re-reads the flow after locking instead of trusting the unlocked state', async () => {
    const s = setup('APPROVED');
    s.flows.lockById.mockResolvedValue({ ...s.row(), state: 'STOPPED' });
    await deliver(s);
    expect(s.asks.open).not.toHaveBeenCalled();
    expect(s.audit.record).not.toHaveBeenCalled();
  });
});
