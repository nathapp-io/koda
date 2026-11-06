import { FLEET_ENTITY_TYPES, type FleetEntityType } from './domain/fleet-activity.domain';
import { FleetActivityService } from './fleet-activity.service';

/**
 * C10 US-003 — adding `provider_credential` to the activity entity types is additive.
 *
 * The activity feed, its filters and the existing nine entity types are untouched: the new member is
 * appended, every pre-existing member keeps its spelling and order, and `record` still stores each of
 * them exactly as the caller named it.
 */
describe('fleet activity entity types', () => {
  const PRE_EXISTING: readonly FleetEntityType[] = [
    'runner', 'enrollment', 'repo', 'job', 'budget', 'schedule', 'approval', 'ingest', 'analytics',
  ];

  it('US-001 AC-12/14: keeps every existing entity type in order, then appends provider_credential and flow', () => {
    expect(FLEET_ENTITY_TYPES).toEqual([...PRE_EXISTING, 'provider_credential', 'flow']);
  });

  it('AC-15: record stores each pre-existing entity type exactly as named', async () => {
    const repo = { create: vi.fn(), findPage: vi.fn() };
    const service = new FleetActivityService(repo as never);

    for (const entityType of PRE_EXISTING) {
      await service.record({ actorType: 'SYSTEM', actorId: 'system', action: 'test.recorded', entityType, entityId: 'e1' });
    }

    expect(repo.create.mock.calls.map(([row]) => row.entityType)).toEqual([...PRE_EXISTING]);
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ payload: {} }));
  });

  it('US-001 AC-12: record stores a flow entity type', async () => {
    const repo = { create: vi.fn(), findPage: vi.fn() };
    const service = new FleetActivityService(repo as never);

    await service.record({
      actorType: 'SYSTEM', actorId: 'flow', action: 'flow.started', entityType: 'flow', entityId: 'flow-1',
    });

    expect(repo.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      entityType: 'flow', entityId: 'flow-1',
    }));
  });

  it('AC-15: record stores a provider_credential entry with its secret-free payload', async () => {
    const repo = { create: vi.fn(), findPage: vi.fn() };
    const service = new FleetActivityService(repo as never);

    await service.record({
      actorType: 'USER', actorId: 'u1', action: 'credential.created', entityType: 'provider_credential',
      entityId: 'cred-1', payload: { providerId: 'openrouter', scope: 'GLOBAL', name: 'fleet', fingerprint: '0123456789ab' },
    });

    expect(repo.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      entityType: 'provider_credential',
      payload: { providerId: 'openrouter', scope: 'GLOBAL', name: 'fleet', fingerprint: '0123456789ab' },
    }));
  });
});
