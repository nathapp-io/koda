import { Reflector } from '@nestjs/core';
import { EnrollmentRetentionProcessor } from './enrollment-retention.processor';
import { testFleetConfig } from '../../common/test-helpers/fleet-config';

describe('EnrollmentRetentionProcessor', () => {
  const repo = { deleteSpentEnrollmentsBefore: jest.fn() };
  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  it('runs daily at 04:30 (03:00 memory governance, 04:00 outbox retention)', () => {
    const p = new EnrollmentRetentionProcessor(repo as never, testFleetConfig());
    expect(new Reflector().get('SCHEDULE_CRON_OPTIONS', p.scheduledPurge)).toMatchObject({ cronTime: '30 4 * * *' });
  });

  it('deletes rows spent before the retention window', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-31T04:30:00.000Z'));
    repo.deleteSpentEnrollmentsBefore.mockResolvedValue(3);
    await new EnrollmentRetentionProcessor(repo as never, testFleetConfig({ enrollmentRetentionDays: 30 })).scheduledPurge();
    expect(repo.deleteSpentEnrollmentsBefore).toHaveBeenCalledWith(new Date('2026-10-01T04:30:00.000Z'));
  });

  it('does nothing when retention is disabled', async () => {
    await new EnrollmentRetentionProcessor(repo as never, testFleetConfig({ enrollmentRetentionDays: null })).scheduledPurge();
    expect(repo.deleteSpentEnrollmentsBefore).not.toHaveBeenCalled();
  });

  it('swallows a failed purge (the next night is the retry)', async () => {
    repo.deleteSpentEnrollmentsBefore.mockRejectedValue(new Error('db down'));
    await expect(new EnrollmentRetentionProcessor(repo as never, testFleetConfig({ enrollmentRetentionDays: 30 })).scheduledPurge()).resolves.toBeUndefined();
  });
});
