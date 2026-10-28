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
    const schedules = { remove: vi.fn().mockResolvedValue(undefined) };
    const permissions = { can: vi.fn().mockResolvedValue({ allowed: false }) };
    new ScheduleRouteCommands(registry, schedules as unknown as SchedulesService, permissions as unknown as PermissionService, loader as unknown as ActorPrincipalLoader).onModuleInit();
    const command = registry.get('fleet.schedule.delete', SCHEDULE_ROUTE_VARIANTS.delete);
    if (!command) throw new Error('Missing schedule command');
    return { command, schedules, permissions, loader, principal };
  }
  it('AC-9: registers the schedule delete variant', () => {
    expect(build().command).toMatchObject({ key: 'fleet.schedule.delete', variant: 'rest:project-fleet-schedules.delete' });
  });
  it('AC-8: reloads principal and recomputes any-row permission on every execution', async () => {
    const { command, schedules, permissions, loader, principal } = build();
    const input = command.parse({ projectId: 'p1', id: 's1', canAdminister: true });
    expect(input).toEqual({ projectId: 'p1', id: 's1' });
    expect(await command.execute(input)).toBeNull();
    expect(loader.forContext).toHaveBeenCalledOnce();
    expect(permissions.can).toHaveBeenCalledExactlyOnceWith(principal, 'fleet.schedule.delete', { projectId: 'p1' });
    expect(schedules.remove).toHaveBeenLastCalledWith(principal.id, 'p1', 's1', false);
    permissions.can.mockResolvedValue({ allowed: true });
    await command.execute(input);
    expect(schedules.remove).toHaveBeenLastCalledWith(principal.id, 'p1', 's1', true);
    expect(command.toResult).toBeUndefined();
  });
  it('validates every identifier and propagates service refusal', async () => {
    const { command, schedules } = build();
    for (const invalid of [null, [], {}, { projectId: 'p1' }, { projectId: '', id: 's1' }, { projectId: 'p1', id: 7 }]) {
      expect(() => command.parse(invalid)).toThrow(ValidationAppException);
    }
    const error = new Error('not owned');
    schedules.remove.mockRejectedValue(error);
    await expect(command.execute(command.parse({ projectId: 'p1', id: 's1' }))).rejects.toBe(error);
  });
});
