import { ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { UserRouteCommands, USER_ROUTE_VARIANTS } from './user-route.commands';

describe('UserRouteCommands', () => {
  function build() {
    const registry = new ApprovalCommandRegistry();
    const users = {
      create: vi.fn().mockResolvedValue({ id: 'u9', email: 'e@x.test', name: 'N' }),
      prepareCreate: vi.fn(),
      update: vi.fn().mockResolvedValue({ id: 'u2', disabled: true }),
    };
    const loader = { forContext: vi.fn().mockResolvedValue({ type: 'USER', id: 'u1' }) };
    new UserRouteCommands(registry, users as never, loader as never).onModuleInit();
    return { registry, users, loader };
  }

  it('AC-8: runs update as the rebuilt principal and retains its result', async () => {
    const { registry, users } = build();
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

  it('AC-10: registers user.create as a redeem command whose redaction drops the password', () => {
    const { registry } = build();

    const command = registry.get('user.create', USER_ROUTE_VARIANTS.create);

    expect(USER_ROUTE_VARIANTS.create).toBe('rest:admin-users.create');
    expect(command).toMatchObject({ key: 'user.create', variant: 'rest:admin-users.create' });
    expect(command?.prepare).toBeTypeOf('function');
    expect(command?.redeem?.redact?.({ user: { email: 'e@x.test', name: 'N', password: 'p' } }))
      .toEqual({ user: { email: 'e@x.test', name: 'N' } });
  });

  it('US-007: parses the body, prepares outside the transaction and creates on the immediate path', async () => {
    const { registry, users, loader } = build();
    const command = registry.get('user.create', USER_ROUTE_VARIANTS.create);
    const mutate = vi.fn().mockResolvedValue({ id: 'u9' });
    users.prepareCreate.mockResolvedValue(mutate);
    if (!command?.prepare) throw new Error('Missing user create command');

    const input = command.parse({
      user: { email: 'E@X.test', name: 'N', password: 'StrongPass123!', admin: true },
    });

    // `parseBody` whitelists, so an undeclared field never reaches the stored request.
    expect(input).toEqual({ user: { email: 'E@X.test', name: 'N', password: 'StrongPass123!' } });
    expect(command.parse(input)).toEqual(input);
    for (const invalid of [null, [], {}, { user: {} }, { user: { email: 'nope', name: 'N', password: 'StrongPass123!' } }]) {
      expect(() => command.parse(invalid)).toThrow(ValidationAppException);
    }

    // `prepare` is what the engine calls before its execution transaction: bcrypt happens there.
    const prepared = await command.prepare(input);
    expect(users.prepareCreate).toHaveBeenCalledExactlyOnceWith({ email: 'E@X.test', name: 'N', password: 'StrongPass123!' });
    expect(mutate).not.toHaveBeenCalled();
    expect(loader.forContext).toHaveBeenCalled();
    expect(await prepared()).toEqual({ id: 'u9' });

    // The immediate path (no policy) runs the service's own create, which prepares again itself.
    await command.execute(input);
    expect(users.create).toHaveBeenCalledExactlyOnceWith({ email: 'E@X.test', name: 'N', password: 'StrongPass123!' });
  });

  it('US-007: stores the created user as the request result', async () => {
    const { registry } = build();
    const command = registry.get('user.create', USER_ROUTE_VARIANTS.create);
    if (!command || !command.toResult) throw new Error('Missing user create command');
    expect(command.toResult({ id: 'u9' })).toEqual({ id: 'u9' });
  });
});
