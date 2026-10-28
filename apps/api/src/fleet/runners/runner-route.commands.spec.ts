import { ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import type { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import type { RunnersService } from './runners.service';
import { RunnerRouteCommands, RUNNER_ROUTE_VARIANTS } from './runner-route.commands';

describe('RunnerRouteCommands', () => {
  function build() {
    const registry = new ApprovalCommandRegistry();
    const result = { id: 'r1', enabled: false };
    const runners = { update: vi.fn().mockResolvedValue(result), remove: vi.fn() };
    const loader = { forContext: vi.fn().mockResolvedValue({ id: 'a1' }) };
    new RunnerRouteCommands(registry, runners as unknown as RunnersService, loader as unknown as ActorPrincipalLoader).onModuleInit();
    return { registry, runners, loader, result };
  }
  it('AC-13: registers both matching variants', () => {
    const { registry } = build();
    expect(Object.values(RUNNER_ROUTE_VARIANTS)).toHaveLength(2);
    for (const action of ['update', 'delete'] as const) expect(registry.get(`fleet.runner.${action}`, RUNNER_ROUTE_VARIANTS[action])).toMatchObject({ key: `fleet.runner.${action}`, variant: `rest:fleet-runners.${action}` });
  });
  it('update parses patch, reloads actor and projects result', async () => {
    const { registry, runners, loader, result } = build();
    const command = registry.get('fleet.runner.update', RUNNER_ROUTE_VARIANTS.update);
    if (!command) throw new Error('Missing route command');
    const input = command.parse({ id: 'r1', patch: { enabled: false, extra: 1 }, extra: 1 });
    expect(input).toEqual({ id: 'r1', patch: { enabled: false } });
    expect(command.parse(input)).toEqual(input);
    expect(command.parse({ id: 'r1' })).toEqual({ id: 'r1', patch: {} });
    for (const patch of [null, [], 'bad', { capacity: -1 }]) expect(() => command.parse({ id: 'r1', patch })).toThrow(ValidationAppException);
    const out = await command.execute(input);
    expect(runners.update).toHaveBeenCalledExactlyOnceWith('a1', 'r1', { enabled: false });
    expect(loader.forContext).toHaveBeenCalledOnce();
    expect(command.toResult?.(out)).toBe(result);
  });
  it('delete parses ids and returns null without a result projector', async () => {
    const { registry, runners } = build();
    const command = registry.get('fleet.runner.delete', RUNNER_ROUTE_VARIANTS.delete);
    if (!command) throw new Error('Missing route command');
    expect(command.parse({ id: 'r1', extra: 1 })).toEqual({ id: 'r1' });
    for (const invalid of [null, [], {}, { id: '' }, { id: 7 }]) expect(() => command.parse(invalid)).toThrow(ValidationAppException);
    expect(await command.execute(command.parse({ id: 'r1' }))).toBeNull();
    expect(runners.remove).toHaveBeenCalledExactlyOnceWith('a1', 'r1');
    expect(command.toResult).toBeUndefined();
  });
});
