import { ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import type { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import type { RunnersService } from './runners.service';
import type { EnrollmentService } from './enrollment.service';
import { RunnerRouteCommands, RUNNER_ROUTE_VARIANTS, ENROLLMENT_ROUTE_VARIANTS } from './runner-route.commands';

describe('RunnerRouteCommands', () => {
  function build() {
    const registry = new ApprovalCommandRegistry();
    const result = { id: 'r1', enabled: false };
    const runners = { update: vi.fn().mockResolvedValue(result), remove: vi.fn(), requestReprobe: vi.fn().mockResolvedValue({ requestedAt: '2026-12-18T09:00:00.000Z' }) };
    const loader = { forContext: vi.fn().mockResolvedValue({ id: 'a1' }) };
    const enrollments = { create: vi.fn().mockResolvedValue({ id: 'e1', labels: [], token: 'ke_x', expiresAt: 'x', usedAt: null, runnerId: null, createdById: 'u1', createdAt: 'x' }) };
    new RunnerRouteCommands(registry, runners as unknown as RunnersService, loader as unknown as ActorPrincipalLoader, enrollments as unknown as EnrollmentService).onModuleInit();
    return { registry, runners, loader, result, enrollments };
  }
  it('AC-13: registers both matching variants', () => {
    const { registry } = build();
    // US-005 adds the re-probe variant under the existing `fleet.runner.update` key.
    expect(Object.values(RUNNER_ROUTE_VARIANTS)).toHaveLength(3);
    for (const [action, key] of [['update', 'fleet.runner.update'], ['delete', 'fleet.runner.delete'], ['reprobe', 'fleet.runner.update']] as const) {
      expect(registry.get(key, RUNNER_ROUTE_VARIANTS[action])).toMatchObject({ key, variant: `rest:fleet-runners.${action}` });
    }
  });
  it('AC-12 (US-005): the reprobe command parses the id and asks the service to re-probe', async () => {
    const { registry, runners, loader } = build();
    const command = registry.get('fleet.runner.update', RUNNER_ROUTE_VARIANTS.reprobe);
    if (!command) throw new Error('Missing reprobe route command');
    expect(command.parse({ id: 'r1', extra: 1 })).toEqual({ id: 'r1' });
    for (const invalid of [null, [], {}, { id: '' }, { id: 7 }]) expect(() => command.parse(invalid)).toThrow(ValidationAppException);
    const out = await command.execute(command.parse({ id: 'r1' }));
    expect(runners.requestReprobe).toHaveBeenCalledExactlyOnceWith('a1', 'r1');
    expect(loader.forContext).toHaveBeenCalledOnce();
    expect(command.toResult?.(out)).toEqual({ requestedAt: '2026-12-18T09:00:00.000Z' });
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
  it('AC-6: registers the enrollment redeem command', () => {
    const { registry } = build();
    expect(registry.get('fleet.enrollment.create', 'rest:fleet-enrollments.create')).toMatchObject({
      key: 'fleet.enrollment.create',
      variant: ENROLLMENT_ROUTE_VARIANTS.create,
      redeem: expect.any(Object),
    });
    expect(registry.get('fleet.enrollment.create', ENROLLMENT_ROUTE_VARIANTS.create)?.redeem).not.toHaveProperty('redact');
    expect(ENROLLMENT_ROUTE_VARIANTS.create).toBe('rest:fleet-enrollments.create');
  });
  it('AC-7: projects the enrollment token out of persisted results', async () => {
    const { registry } = build();
    const command = registry.get('fleet.enrollment.create', ENROLLMENT_ROUTE_VARIANTS.create);
    if (!command) throw new Error('Missing enrollment route command');
    expect(command.toResult?.({ id: 'e1', labels: [], token: 'ke_x', expiresAt: 'x', usedAt: null, runnerId: null, createdById: 'u1', createdAt: 'x' }))
      .toEqual({ id: 'e1', labels: [], expiresAt: 'x', usedAt: null, runnerId: null, createdById: 'u1', createdAt: 'x' });
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
