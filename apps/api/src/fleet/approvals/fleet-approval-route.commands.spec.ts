import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import { FleetApprovalRouteCommands } from './fleet-approval-route.commands';

const principal = { actorType: 'agent', id: 'decider' };
function build() {
  const registry = new ApprovalCommandRegistry();
  const approvals = { recordDecide: vi.fn(async () => ({ id: 'r1' })) };
  const execution = { execute: vi.fn() };
  const loader = { forContext: vi.fn(async () => principal) };
  new FleetApprovalRouteCommands(registry, approvals as never, execution as never, loader as never).onModuleInit();
  return { registry, approvals, execution, loader };
}

describe('fleet approval REST commands', () => {
  it.each(['fleet.approval.decide.bash', 'fleet.approval.decide.budget'])('AC-11: registers %s with the REST variant and skips metadata key recheck', (key) => {
    const command = build().registry.get(key, 'rest:project-fleet-approvals.decide');
    expect(command).toMatchObject({ key, variant: 'rest:project-fleet-approvals.decide', skipKeyRecheck: true });
  });
  it.each(['fleet.approval.decide.bash', 'fleet.approval.decide.budget'])('AC-12: %s executes only approved inner requests after commit', async (key) => {
    const { registry, execution } = build();
    const command = registry.get(key, 'rest:project-fleet-approvals.decide');
    if (!command?.afterCommit) throw new Error('missing command hook');
    await command.afterCommit({ requestId: 'r1', decision: 'reject', comment: null }, undefined, undefined);
    expect(execution.execute).not.toHaveBeenCalled();
    await command.afterCommit({ requestId: 'r1', decision: 'approve', comment: null }, undefined, undefined);
    expect(execution.execute).toHaveBeenCalledExactlyOnceWith('r1');
  });
  it('parses the translated decision, passes principal and params to recordDecide, and rejects malformed input', async () => {
    const { registry, approvals, execution } = build();
    const command = registry.get('fleet.approval.decide.bash', 'rest:project-fleet-approvals.decide');
    if (!command) throw new Error('missing command');
    const input = { requestId: 'r1', decision: 'approve', comment: null, params: { choice: 'allow' } };
    expect(command.parse(input)).toEqual(input);
    await command.execute(input);
    expect(approvals.recordDecide).toHaveBeenCalledWith(principal, input);
    expect(execution.execute).not.toHaveBeenCalled();
    for (const invalid of [null, [], {}, { ...input, requestId: '' }, { ...input, decision: 'allow' }, { ...input, comment: 1 }]) {
      expect(() => command.parse(invalid)).toThrow();
    }
  });
});
