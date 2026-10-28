/**
 * US-003 AC-4 and AC-5 — `routeCommand` adapts a route's spec to the registry's command shape,
 * loading the principal on the immediate path as well as the deferred one.
 */
import type { UserPrincipal } from '../../auth/principal/koda-principal.types';
import { routeCommand, type RouteCommandSpec } from './route-command';

const principal: UserPrincipal = {
  actorType: 'user', id: 'u1', name: 'user@example.test', email: 'user@example.test', role: 'MEMBER',
  blacklisted: false, revoked: false, authorities: ['MEMBER'], extra: {},
};

const input = { key: 'qa' };

describe('routeCommand', () => {
  it('AC-4: keeps the spec key and variant on the command', () => {
    const command = routeCommand(
      { key: 'role.manage', variant: 'rest:x', parse: (raw) => raw as { key: string }, run: async () => 'done' },
      { forContext: async () => principal },
    );

    expect(command.key).toBe('role.manage');
    expect(command.variant).toBe('rest:x');
  });

  it('AC-5: execute runs the spec with the context principal and the input', async () => {
    const run = vi.fn(async () => 'done');
    const forContext = vi.fn(async () => principal);
    const command = routeCommand(
      { key: 'role.manage', variant: 'rest:x', parse: (raw) => raw as typeof input, run },
      { forContext },
    );

    await expect(command.execute(input)).resolves.toBe('done');
    expect(forContext).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(principal, input);
  });

  it('takes parse and toResult from the spec when it has them', async () => {
    const spec: RouteCommandSpec<{ key: string }, { id: string }> = {
      key: 'role.manage',
      variant: 'rest:x',
      parse: (raw) => raw as { key: string },
      run: async () => ({ id: 'role-1' }),
      toResult: (result) => result.id,
    };
    const command = routeCommand(spec, { forContext: async () => principal });

    expect(command.parse({ key: 'qa' })).toEqual({ key: 'qa' });
    expect(command.toResult?.({ id: 'role-1' })).toBe('role-1');
  });

  it('omits toResult when the spec has none', () => {
    const command = routeCommand(
      { key: 'role.manage', variant: 'rest:x', parse: (raw) => raw, run: async () => 'done' },
      { forContext: async () => principal },
    );

    expect(command.toResult).toBeUndefined();
  });
});
