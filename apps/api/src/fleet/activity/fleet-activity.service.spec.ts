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
