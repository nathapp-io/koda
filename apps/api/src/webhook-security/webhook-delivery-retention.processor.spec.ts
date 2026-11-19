import { Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuditRecordInput } from '../audit/audit-recorder.service';
import type { IRetentionConfig } from '../config/retention.config';
import { WebhookDeliveryRetentionProcessor } from './webhook-delivery-retention.processor';

const config = (webhookDeliveryDays: number | null): IRetentionConfig => ({
  webhookDeliveryDays,
  approvalDays: 180,
  auditDays: 365,
});

/** The processor, its collaborators and the entries the recorder would have written. */
function setup(retention: IRetentionConfig | undefined) {
  const repository = { deleteReceivedBefore: vi.fn().mockResolvedValue(0) };
  const configService = { get: vi.fn().mockReturnValue(retention) };
  const recorded: AuditRecordInput[] = [];
  // The recorder's own contract: run the write, then record what its result describes.
  const audit = {
    audited: vi.fn(async (
      fn: () => Promise<number>,
      entriesOf: (count: number) => AuditRecordInput | readonly AuditRecordInput[],
    ) => {
      const count = await fn();
      const entries = entriesOf(count);
      for (const entry of Array.isArray(entries) ? entries : [entries]) recorded.push(entry);
      return count;
    }),
  };
  const processor = new WebhookDeliveryRetentionProcessor(
    repository as never,
    configService as never,
    audit as never,
  );
  return { processor, repository, configService, audit, recorded };
}

describe('WebhookDeliveryRetentionProcessor (US-002)', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('runs nightly at 05:00', () => {
    const { processor } = setup(config(30));
    const cronOptions = new Reflector().get('SCHEDULE_CRON_OPTIONS', processor.scheduledPurge);
    expect(cronOptions).toMatchObject({ cronTime: '0 5 * * *' });
  });

  it('AC-6: purges with a cutoff exactly 30 days before now', async () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-10-09T05:00:00.000Z'));
    const { processor, repository } = setup(config(30));

    await processor.scheduledPurge();

    expect(repository.deleteReceivedBefore).toHaveBeenCalledWith(new Date('2026-09-09T05:00:00.000Z'));
  });

  it('AC-7: records exactly one retention entry naming what it purged', async () => {
    const { processor, repository, recorded } = setup(config(30));
    repository.deleteReceivedBefore.mockResolvedValue(2);

    await processor.scheduledPurge();

    expect(recorded).toEqual([{
      key: 'system.webhook-delivery.retention',
      resourceType: 'webhook-delivery',
      resourceId: 'all',
      projectId: null,
      summary: 'purged 2 webhook deliveries',
    }]);
  });

  it('is a no-op when the retention horizon is off (repo never called, nothing recorded)', async () => {
    const { processor, repository, recorded } = setup(config(null));

    await processor.scheduledPurge();

    expect(repository.deleteReceivedBefore).not.toHaveBeenCalled();
    expect(recorded).toEqual([]);
  });

  it('records nothing when the purge deletes nothing', async () => {
    const { processor, recorded } = setup(config(30));

    await processor.scheduledPurge();

    expect(recorded).toEqual([]);
  });

  it('logs and swallows a failed purge (the next night retries)', async () => {
    const { processor, repository } = setup(config(30));
    repository.deleteReceivedBefore.mockRejectedValue(new Error('deadlock detected'));
    const errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    errorLog.mockClear();

    await expect(processor.scheduledPurge()).resolves.toBeUndefined();

    expect(errorLog.mock.calls.map((call) => call[0])).toContain(
      'Webhook delivery retention purge failed, will retry next run: deadlock detected',
    );
  });
});
