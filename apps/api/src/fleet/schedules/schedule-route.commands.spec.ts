import { ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import type { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import type { AgentPrincipal } from '../../auth/principal/koda-principal.types';
import type { PermissionService } from '../../permissions/permission.service';
import type { SchedulesService } from './schedules.service';
import { ScheduleRouteCommands, SCHEDULE_ROUTE_VARIANTS } from './schedule-route.commands';

describe('ScheduleRouteCommands', () => {
  function build() {
    const registry = new ApprovalCommandRegistry();
    const principal = { id: 'a1', actorType: 'agent', slug: 'agent', status: 'ACTIVE', capabilities: [] } satisfies AgentPrincipal;
    const loader = { forContext: vi.fn().mockResolvedValue(principal) };
    const schedules = { create: vi.fn(), update: vi.fn(), enable: vi.fn(), disable: vi.fn(), remove: vi.fn() };
    const permissions = { can: vi.fn().mockResolvedValue({ allowed: false }) };
    new ScheduleRouteCommands(registry, schedules as unknown as SchedulesService, permissions as unknown as PermissionService, loader as unknown as ActorPrincipalLoader).onModuleInit();
    return { registry, schedules, permissions, loader, principal };
  }

  it('AC-10: registers create, update, enable and disable variants', () => {
    const { registry } = build();
    expect(registry.get('fleet.schedule.create', SCHEDULE_ROUTE_VARIANTS.create)).toMatchObject({ key: 'fleet.schedule.create' });
    for (const variant of [SCHEDULE_ROUTE_VARIANTS.update, SCHEDULE_ROUTE_VARIANTS.enable, SCHEDULE_ROUTE_VARIANTS.disable]) {
      expect(registry.get('fleet.schedule.update', variant)).toMatchObject({ key: 'fleet.schedule.update' });
    }
  });

  it('AC-11: parses update input and recomputes any-row authority at execution', async () => {
    const { registry, schedules, permissions, principal } = build();
    permissions.can.mockResolvedValue({ allowed: true });
    const command = registry.get('fleet.schedule.update', SCHEDULE_ROUTE_VARIANTS.update);
    if (!command) throw new Error('Missing update command');
    const input = command.parse({ slug: 'web', projectId: 'p1', id: 's1', patch: { maxCostUsd: 7 } });
    expect(await command.execute(input)).toBe(schedules.update.mock.results[0]?.value);
    expect(permissions.can).toHaveBeenCalledExactlyOnceWith(principal, 'fleet.schedule.update', { projectId: 'p1' });
    expect(schedules.update).toHaveBeenCalledExactlyOnceWith('a1', 'p1', 's1', { maxCostUsd: 7 }, true);
    expect(command.toResult).toBeTypeOf('function');
  });

  it('AC-12: passes execution-time authority to enable', async () => {
    const { registry, schedules, permissions } = build();
    const command = registry.get('fleet.schedule.update', SCHEDULE_ROUTE_VARIANTS.enable);
    if (!command) throw new Error('Missing enable command');
    await command.execute(command.parse({ slug: 'web', projectId: 'p1', id: 's1' }));
    expect(permissions.can).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'fleet.schedule.update', { projectId: 'p1' });
    expect(schedules.enable).toHaveBeenCalledExactlyOnceWith('a1', 'p1', 's1', false);
  });

  it('registers delete and validates route input', async () => {
    const { registry, schedules } = build();
    const command = registry.get('fleet.schedule.delete', SCHEDULE_ROUTE_VARIANTS.delete);
    if (!command) throw new Error('Missing delete command');
    expect(command).toMatchObject({ key: 'fleet.schedule.delete' });
    for (const invalid of [null, [], {}, { projectId: 'p1' }, { projectId: '', id: 's1' }, { projectId: 'p1', id: 7 }]) {
      expect(() => command.parse(invalid)).toThrow(ValidationAppException);
    }
    await command.execute(command.parse({ projectId: 'p1', id: 's1' }));
    expect(schedules.remove).toHaveBeenCalledWith('a1', 'p1', 's1', false);
  });
});
