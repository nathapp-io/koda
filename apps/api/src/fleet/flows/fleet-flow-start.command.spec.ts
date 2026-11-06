import { describe, expect, it, vi } from 'vitest';
import { runWithActionContext } from '../../action-context/action-context';
import { FleetFlowStartCommand } from './fleet-flow-start.command';

const sha = 'a'.repeat(40);
const flow = {
  id: 'f1', projectId: 'p1', state: 'PENDING', approvalRequestId: 'request-1', specSha: sha,
  branch: 'feat/example', costCapUsd: '5.0000', features: [{ feature: 'one' }],
};

function setup() {
  const flows = {
    lockById: vi.fn().mockResolvedValue(flow),
    approve: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    findById: vi.fn().mockResolvedValue(flow),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const activity = { record: vi.fn().mockResolvedValue(undefined) };
  const command = new FleetFlowStartCommand(flows as never, audit as never, activity as never);
  return { command, flows, audit, activity };
}

const context = { actor: { type: 'USER' as const, id: 'approver-1' }, origin: 'api' as const, correlationId: 'c1', approval: { requiredMode: 'human' as const, satisfiedBy: 'human' as const, requestId: 'request-1', approverId: 'approver-1' } };

describe('FleetFlowStartCommand', () => {
  it('parses exactly a flow id and lowercase 40-character sha', () => {
    const { command } = setup();
    expect(command.parse({ flowId: 'f1', specSha: sha })).toEqual({ flowId: 'f1', specSha: sha });
  });

  it.each(['a'.repeat(39), 'A'.repeat(40)])('rejects an invalid sha: %s', (specSha) => {
    const { command } = setup();
    expect(() => command.parse({ flowId: 'f1', specSha })).toThrow();
  });

  it('approves only the current pending flow and records audit and activity', async () => {
    const { command, flows, audit, activity } = setup();
    const result = await runWithActionContext(context, () => command.execute({ flowId: 'f1', specSha: sha }));
    expect(result).toEqual({ applied: true });
    expect(flows.approve).toHaveBeenCalledWith('f1', expect.objectContaining({ mode: 'REQUEST', approverId: 'approver-1', approvalRequestId: 'request-1' }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ key: 'fleet.flow.start', resourceType: 'flow', resourceId: 'f1', projectId: 'p1' }));
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'flow.approved', entityType: 'flow', entityId: 'f1', projectId: 'p1' }));
  });

  it('does nothing for missing or stale approval targets', async () => {
    const { command, flows, audit, activity } = setup();
    flows.lockById.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...flow, state: 'STOPPED' }).mockResolvedValueOnce({ ...flow, approvalRequestId: 'request-old' }).mockResolvedValueOnce({ ...flow, specSha: 'b'.repeat(40) });
    for (let i = 0; i < 4; i += 1) {
      await expect(runWithActionContext(context, () => command.execute({ flowId: 'f1', specSha: sha }))).resolves.toEqual({ applied: false });
    }
    expect(flows.approve).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(activity.record).not.toHaveBeenCalled();
  });

  it('rejects the current request by stopping and auditing the flow', async () => {
    const { command, flows, audit, activity } = setup();
    await runWithActionContext(context, () => command.onReject({ flowId: 'f1', specSha: sha }));
    expect(flows.stop).toHaveBeenCalledWith('f1', 'approval_rejected', expect.any(Date));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ key: 'fleet.flow.start', resourceId: 'f1' }));
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'flow.stopped', entityId: 'f1' }));
  });

  it('returns approval details for the flow or null when deleted', async () => {
    const { command, flows } = setup();
    await expect(command.details({ id: 'request-1', input: { flowId: 'f1', specSha: sha } } as never)).resolves.toEqual({
      kind: 'flow', flowId: 'f1', state: 'PENDING', branch: 'feat/example', specSha: sha,
      costCapUsd: '5.0000', features: [{ feature: 'one' }],
    });
    flows.findById.mockResolvedValueOnce(null);
    await expect(command.details({ id: 'request-1', input: { flowId: 'gone', specSha: sha } } as never)).resolves.toBeNull();
  });
});
