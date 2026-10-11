import { NotFoundAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { testFleetConfig } from '../../common/test-helpers/fleet-config';
import { RunnersService } from './runners.service';

const row = (over = {}) => ({
  id: 'r1', name: 'box', os: 'linux', arch: 'x64', labels: ['linux'], capacity: 1, threadCapacity: 2, capabilities: {},
  daemonVersion: '0.1.0', protocolVersion: 1, bootId: 'b', bootedAt: null, enabled: true, lastSeenAt: new Date(0),
  createdById: 'u1', createdAt: new Date(0), updatedAt: new Date(0), ...over,
});

describe('RunnersService', () => {
  const repo = { findRunnerById: jest.fn(), findRunnerPage: jest.fn(), updateRunner: jest.fn(), deleteRunner: jest.fn(), lockForDelete: jest.fn(), countUnfinishedJobs: jest.fn() };
  const activity = { record: jest.fn() };
  const tx = { run: <T>(fn: () => Promise<T>) => fn(), isInTransaction: () => false };
  const service = new RunnersService(repo as never, activity as never, tx as never, testFleetConfig({ runnerOfflineSec: 90 }));

  beforeEach(() => jest.clearAllMocks());

  it('404s an unknown runner', async () => {
    repo.findRunnerById.mockResolvedValue(null);
    await expect(service.get('nope')).rejects.toBeInstanceOf(NotFoundAppException);
  });

  it('computes online against FLEET_RUNNER_OFFLINE_SEC at the given time', async () => {
    const now = new Date('2026-10-01T12:00:00.000Z');
    repo.findRunnerById.mockResolvedValue(row({ lastSeenAt: new Date(now.getTime() - 90_000) }));
    expect((await service.get('r1', now)).online).toBe(true);
    repo.findRunnerById.mockResolvedValue(row({ lastSeenAt: new Date(now.getTime() - 90_001) }));
    expect((await service.get('r1', now)).online).toBe(false);
  });

  it('lists project summaries with online computed at the given time', async () => {
    const now = new Date('2026-10-01T12:00:00.000Z');
    repo.findRunnerPage.mockResolvedValue({
      total: 1, current: 1, size: 100, hasNext: false, hasPrev: false,
      records: [row({ lastSeenAt: now, capabilities: { profiles: { fast: {} } } })],
    });
    const page = await service.listSummaries({ current: 1, size: 100 }, now);
    expect(page.records).toEqual([expect.objectContaining({ id: 'r1', online: true, profiles: ['fast'] })]);
  });

  it('updates enabled/labels/capacity and records the change', async () => {
    repo.findRunnerById.mockResolvedValue(row());
    repo.updateRunner.mockResolvedValue(row({ enabled: false, labels: ['a', 'b'], capacity: 2 }));
    const dto = await service.update('u9', 'r1', { enabled: false, labels: ['b', 'a', 'a'], capacity: 2 });
    expect(repo.updateRunner).toHaveBeenCalledWith('r1', { enabled: false, labels: ['a', 'b'], capacity: 2 });
    expect(dto.enabled).toBe(false);
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'u9', action: 'runner.updated', entityId: 'r1', payload: { enabled: false, labels: ['a', 'b'], capacity: 2 } }));
  });

  it('carries threadCapacity through update to the repository and the response (US-002 AC5)', async () => {
    repo.findRunnerById.mockResolvedValue(row());
    repo.updateRunner.mockResolvedValue(row({ threadCapacity: 3 }));
    const dto = await service.update('u9', 'r1', { threadCapacity: 3 });
    expect(repo.updateRunner).toHaveBeenCalledWith('r1', { threadCapacity: 3 });
    expect(dto.threadCapacity).toBe(3);
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
