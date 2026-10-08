import { Logger } from '@nestjs/common';
import { NotificationRetentionProcessor } from './notification-retention.processor';
import type { INotificationsConfig } from '../config/notifications.config';

function setup(config: INotificationsConfig | undefined) {
  const repo = { purgeRead: jest.fn().mockResolvedValue(7) };
  const cfg = { get: jest.fn().mockReturnValue(config) };
  const healthAlerts = { purgeClosed: jest.fn().mockResolvedValue(0) };
  const processor = new NotificationRetentionProcessor(repo as never, cfg as never, healthAlerts as never);
  return { processor, repo, healthAlerts };
}

describe('NotificationRetentionProcessor (S4a D511)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('purges read rows older than the retention window', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-09T04:30:00Z'));
    try {
      const { processor, repo } = setup({ retentionDays: 90 });
      await processor.scheduledPurge();
      expect(repo.purgeRead).toHaveBeenCalledWith(new Date('2026-07-11T04:30:00Z'));
    } finally {
      jest.useRealTimers();
    }
  });

  it('does nothing when retention is off or the config is missing', async () => {
    for (const config of [{ retentionDays: null }, undefined]) {
      const { processor, repo } = setup(config);
      await processor.scheduledPurge();
      expect(repo.purgeRead).not.toHaveBeenCalled();
    }
  });

  it('logs and swallows a failed purge (next night retries)', async () => {
    const { processor, repo } = setup({ retentionDays: 90 });
    repo.purgeRead.mockRejectedValueOnce(new Error('db down'));
    await expect(processor.scheduledPurge()).resolves.toBeUndefined();
  });

  it('purges health alerts closed more than 30 days ago, even with notification retention off (S4a §1)', async () => {
    const { processor, healthAlerts } = setup({ retentionDays: null });
    await processor.purge(new Date('2026-10-09T04:30:00.000Z'));
    expect(healthAlerts.purgeClosed).toHaveBeenCalledWith(new Date('2026-09-09T04:30:00.000Z'));
  });

  it('a failed notification purge does not skip the health-alert purge', async () => {
    const { processor, repo, healthAlerts } = setup({ retentionDays: 90 });
    repo.purgeRead.mockRejectedValueOnce(new Error('db down'));
    await processor.purge(new Date('2026-10-09T04:30:00.000Z'));
    expect(healthAlerts.purgeClosed).toHaveBeenCalled();
  });
});
