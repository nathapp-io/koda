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
  it('PR AC-6: afterCommit reloads the requester and forwards input and raw result', async () => {
    const reloaded = { ...principal, name: 'reloaded' };
    const forContext = vi.fn().mockResolvedValueOnce(principal).mockResolvedValueOnce(reloaded);
    const afterCommit = vi.fn().mockResolvedValue(undefined);
    const command = routeCommand({ key: 'vcs.sync.pr', variant: 'rest:x', parse: () => input, run: async () => ({ updated: 1 }), afterCommit }, { forContext });
    const result = await command.execute(input);
    expect(command.afterCommit).toBeTypeOf('function');
    if (!command.afterCommit) throw new Error('Missing hook');
    await command.afterCommit(input, undefined, result);
    expect(afterCommit).toHaveBeenCalledExactlyOnceWith(reloaded, input, result);
    expect(forContext).toHaveBeenCalledTimes(2);
  });

  it('PR AC-7: omits afterCommit entirely without a spec hook', () => {
    const command = routeCommand({ key: 'vcs.sync.pr', variant: 'rest:x', parse: () => input, run: async () => 1 }, { forContext: async () => principal });
    expect(command).not.toHaveProperty('afterCommit');
  });
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

  it('AC-8: passes the spec redeem through and omits it when the spec has none', () => {
    const redact = vi.fn((input: { key: string }) => ({ key: input.key }));
    const withRedeem = routeCommand(
      { key: 'agent.create', variant: 'rest:test.redeem', parse: (raw) => raw as { key: string }, run: async () => 'done', redeem: { redact } },
      { forContext: async () => principal },
    );
    const withoutRedeem = routeCommand(
      { key: 'agent.create', variant: 'rest:test.redeem', parse: (raw) => raw as { key: string }, run: async () => 'done' },
      { forContext: async () => principal },
    );

    expect(withRedeem.redeem?.redact).toBe(redact);
    expect(withRedeem.redeem?.redact?.({ key: 'qa' })).toEqual({ key: 'qa' });
    expect(redact).toHaveBeenCalledExactlyOnceWith({ key: 'qa' });
    expect(withoutRedeem.redeem).toBeUndefined();
  });

  it('carries the self-authorising flag only when the spec asks for it', () => {
    const base = { key: 'approval.decide', variant: 'rest:x', parse: (raw: unknown) => raw, run: async () => 'done' };

    expect(routeCommand(base, { forContext: async () => principal }).skipKeyRecheck).toBeUndefined();
    expect(routeCommand({ ...base, skipKeyRecheck: true }, { forContext: async () => principal }).skipKeyRecheck).toBe(true);
  });
});
