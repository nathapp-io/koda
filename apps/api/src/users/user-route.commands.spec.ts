import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { UserRouteCommands, USER_ROUTE_VARIANTS } from './user-route.commands';

describe('UserRouteCommands', () => {
  it('AC-8: runs update as the rebuilt principal and retains its result', async () => {
    const registry = new ApprovalCommandRegistry();
    const users = { update: vi.fn().mockResolvedValue({ id: 'u2', disabled: true }) };
    const loader = { forContext: vi.fn().mockResolvedValue({ type: 'USER', id: 'u1' }) };
    new UserRouteCommands(registry, users as never, loader as never).onModuleInit();
    const command = registry.get('user.update', USER_ROUTE_VARIANTS.update);
    if (!command || !command.toResult) throw new Error('Missing user command');
    const input = command.parse({ id: 'u2', patch: { disabled: true } });
    const result = await command.execute(input);
    expect(users.update).toHaveBeenCalledExactlyOnceWith('u1', 'u2', { disabled: true });
    expect(command.toResult(result)).toEqual({ id: 'u2', disabled: true });
    expect(command.parse({ id: 'u2' })).toEqual({ id: 'u2', patch: {} });
    expect(() => command.parse({ id: 'u2', patch: { disabled: 'yes' } })).toThrow();
    expect(() => command.parse({ id: '' })).toThrow();
  });
});
