import { ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import type { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import type { AnalyticsService } from './analytics.service';
import { AnalyticsRouteCommands, ANALYTICS_ROUTE_VARIANTS } from './analytics-route.commands';

describe('AnalyticsRouteCommands', () => {
  afterEach(() => { vi.useRealTimers(); });
  const before = '2026-01-01T00:00:00Z';
  function build() {
    const registry = new ApprovalCommandRegistry();
    const result = { costEvents: 1 };
    const analytics = { deleteRows: vi.fn().mockResolvedValue(result) };
    const loader = { forContext: vi.fn().mockResolvedValue({ id: 'a1' }) };
    new AnalyticsRouteCommands(registry, analytics as unknown as AnalyticsService, loader as unknown as ActorPrincipalLoader).onModuleInit();
    return { registry, analytics, loader, result };
  }
  it('AC-14: registers the matching delete variant', () => {
    expect(build().registry.get('fleet.analytics.delete', ANALYTICS_ROUTE_VARIANTS.delete)).toMatchObject({ key: 'fleet.analytics.delete', variant: 'rest:fleet-analytics.delete' });
  });
  it('AC-15: missing confirm throws approvals.invalidInput', () => {
    const command = build().registry.get('fleet.analytics.delete', ANALYTICS_ROUTE_VARIANTS.delete);
    if (!command) throw new Error('Missing route command');
    expect(() => command.parse({ before, extra: 1 })).toThrow(ValidationAppException);
    try { command.parse({ before, extra: 1 }); } catch (error) {
      expect(error).toMatchObject(new ValidationAppException({}, 'approvals.invalidInput'));
    }
  });
  it('strips undeclared fields and uses execution time rather than parse time', async () => {
    const { registry, analytics, loader, result } = build();
    const command = registry.get('fleet.analytics.delete', ANALYTICS_ROUTE_VARIANTS.delete);
    if (!command) throw new Error('Missing route command');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-01T00:00:00Z'));
    const parsed = command.parse({ before, projectId: 'p1', confirm: 'web', extra: 1 });
    expect(parsed).toEqual({ before, projectId: 'p1', confirm: 'web' });
    expect(command.parse(parsed)).toEqual(parsed);
    const executionTime = new Date('2026-03-01T00:00:00Z');
    vi.setSystemTime(executionTime);
    const out = await command.execute(parsed);
    expect(analytics.deleteRows).toHaveBeenCalledExactlyOnceWith('a1', parsed, executionTime);
    expect(loader.forContext).toHaveBeenCalledOnce();
    expect(command.toResult?.(out)).toBe(result);
    for (const invalid of [null, [], {}, { before: 'bad', confirm: 'ALL' }, { before, confirm: 7 }]) expect(() => command.parse(invalid)).toThrow(ValidationAppException);
  });
});
