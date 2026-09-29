import { NotFoundAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { RunnersService } from './runners.service';

const row = (over = {}) => ({
  id: 'r1', name: 'box', os: 'linux', arch: 'x64', labels: ['linux'], capacity: 1, capabilities: {},
  daemonVersion: '0.1.0', protocolVersion: 1, bootId: 'b', enabled: true, lastSeenAt: new Date(0),
  createdById: 'u1', createdAt: new Date(0), updatedAt: new Date(0), ...over,
});

describe('RunnersService', () => {
  const repo = { findRunnerById: jest.fn(), findRunnerPage: jest.fn(), updateRunner: jest.fn(), deleteRunner: jest.fn(), lockForDelete: jest.fn(), countUnfinishedJobs: jest.fn() };
  const activity = { record: jest.fn() };
  const tx = { run: <T>(fn: () => Promise<T>) => fn(), isInTransaction: () => false };
  const service = new RunnersService(repo as never, activity as never, tx as never);

  beforeEach(() => jest.clearAllMocks());

  it('404s an unknown runner', async () => {
    repo.findRunnerById.mockResolvedValue(null);
    await expect(service.get('nope')).rejects.toBeInstanceOf(NotFoundAppException);
  });

  it('updates enabled/labels/capacity and records the change', async () => {
    repo.findRunnerById.mockResolvedValue(row());
    repo.updateRunner.mockResolvedValue(row({ enabled: false, labels: ['a', 'b'], capacity: 2 }));
    const dto = await service.update('u9', 'r1', { enabled: false, labels: ['b', 'a', 'a'], capacity: 2 });
    expect(repo.updateRunner).toHaveBeenCalledWith('r1', { enabled: false, labels: ['a', 'b'], capacity: 2 });
    expect(dto.enabled).toBe(false);
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'u9', action: 'runner.updated', entityId: 'r1', payload: { enabled: false, labels: ['a', 'b'], capacity: 2 } }));
  });

  it('deletes and records', async () => {
    repo.findRunnerById.mockResolvedValue(row());
    repo.countUnfinishedJobs.mockResolvedValue(0);
    await service.remove('u9', 'r1');
    expect(repo.lockForDelete).toHaveBeenCalledWith('r1');
    expect(repo.deleteRunner).toHaveBeenCalledWith('r1');
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'runner.deleted', entityId: 'r1', payload: { name: 'box' } }));
  });

  it('409s a runner with unfinished or pinned jobs', async () => {
    repo.findRunnerById.mockResolvedValue(row());
    repo.countUnfinishedJobs.mockResolvedValue(2);
    await expect(service.remove('u9', 'r1')).rejects.toBeInstanceOf(ConflictAppException);
    expect(repo.deleteRunner).not.toHaveBeenCalled();
  });
});
