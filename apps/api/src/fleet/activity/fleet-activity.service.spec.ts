import { runWithActor } from '../../action-context/action-context';
import { FleetActivityService } from './fleet-activity.service';

describe('FleetActivityService', () => {
  const repo = { create: vi.fn(), findPage: vi.fn() };
  const service = new FleetActivityService(repo as never);

  beforeEach(() => vi.clearAllMocks());

  it('records an entry with defaults for optional fields', async () => {
    await service.record({ actorType: 'USER', actorId: 'u1', action: 'runner.deleted', entityType: 'runner', entityId: 'r1' });
    expect(repo.create).toHaveBeenCalledWith({
      actorType: 'USER', actorId: 'u1', action: 'runner.deleted', entityType: 'runner', entityId: 'r1',
      jobId: null, projectId: null, responsibleUserId: null, payload: {},
    });
  });

  it('never stores secret-looking payload keys', async () => {
    await expect(
      service.record({ actorType: 'USER', actorId: 'u1', action: 'enrollment.created', entityType: 'enrollment', entityId: 'e1', payload: { token: 'ke_x' } }),
    ).rejects.toThrow('activity payload must not contain secrets');
  });

  it('accepts a replacedPath payload key from bundle.orphan_file', async () => {
    await service.record({ actorType: 'SYSTEM', actorId: 'system', action: 'bundle.orphan_file', entityType: 'job', entityId: 'j1', payload: { replacedPath: '/var/lib/koda/artifacts/jobs/j1/1/uuid.tar.gz', error: 'EACCES' } });
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ action: 'bundle.orphan_file', payload: { replacedPath: '/var/lib/koda/artifacts/jobs/j1/1/uuid.tar.gz', error: 'EACCES' } }));
  });

  describe('actoring labels (US-001)', () => {
    const entryFor = (actorType: 'USER' | 'SYSTEM' | 'AGENT', actorId: string) => ({
      actorType,
      actorId,
      action: 'job.dispatched',
      entityType: 'job' as const,
      entityId: 'j1',
    });

    it('AC-9: records a USER entry about the current agent as AGENT', async () => {
      await runWithActor({ type: 'AGENT', id: 'a1' }, () => service.record(entryFor('USER', 'a1')));

      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ actorType: 'AGENT', actorId: 'a1' }));
    });

    it('AC-10: keeps a USER entry about someone else a USER', async () => {
      await runWithActor({ type: 'AGENT', id: 'a1' }, () => service.record(entryFor('USER', 'u2')));

      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ actorType: 'USER', actorId: 'u2' }));
    });

    it('AC-11: never relabels a SYSTEM entry', async () => {
      await runWithActor({ type: 'AGENT', id: 'a1' }, () => service.record(entryFor('SYSTEM', 'a1')));

      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ actorType: 'SYSTEM', actorId: 'a1' }));
    });

    it('AC-23: writes a USER entry outside any context as USER', async () => {
      await service.record(entryFor('USER', 'a1'));

      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ actorType: 'USER', actorId: 'a1' }));
    });

    it('records an AGENT entry the caller labelled itself', async () => {
      await service.record(entryFor('AGENT', 'a1'));

      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ actorType: 'AGENT', actorId: 'a1' }));
    });
  });

  it('maps a page of rows to DTOs with ISO timestamps', async () => {
    const createdAt = new Date('2026-09-30T00:00:00.000Z');
    repo.findPage.mockResolvedValue({
      total: 1, current: 1, size: 20, hasNext: false, hasPrev: false,
      records: [{ id: 'a1', actorType: 'USER', actorId: 'u1', action: 'repo.created', entityType: 'repo', entityId: 'fr1', jobId: null, projectId: null, responsibleUserId: null, payload: {}, createdAt }],
    });
    const page = await service.list({}, { current: 1, size: 20 });
    expect(page.records[0]).toEqual(expect.objectContaining({ id: 'a1', createdAt: '2026-09-30T00:00:00.000Z' }));
  });
});
