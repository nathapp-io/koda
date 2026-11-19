import { Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuditRecordInput } from '../audit/audit-recorder.service';
import type { IRetentionConfig } from '../config/retention.config';
import { AuditRetentionProcessor } from './audit-retention.processor';

const config = (auditDays: number | null): IRetentionConfig => ({
  webhookDeliveryDays: 30,
  approvalDays: 180,
  auditDays,
});

/** The processor, its collaborators and the entries the recorder would have written. */
function setup(retention: IRetentionConfig | undefined) {
  const repository = { deleteCreatedBefore: vi.fn().mockResolvedValue(0) };
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
  const processor = new AuditRetentionProcessor(repository as never, configService as never, audit as never);
  return { processor, repository, configService, audit, recorded };
}

/** The error messages the processor logged during `fn`, isolated from earlier tests in this file. */
async function errorMessagesOf(fn: () => Promise<void>): Promise<unknown[]> {
  const errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  errorLog.mockClear();

  await fn();

  return errorLog.mock.calls.map((call) => call[0]);
}

describe('AuditRetentionProcessor (US-002)', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('runs nightly at 05:30, after the webhook purge', () => {
    const { processor } = setup(config(365));
    const cronOptions = new Reflector().get('SCHEDULE_CRON_OPTIONS', processor.scheduledPurge);
    expect(cronOptions).toMatchObject({ cronTime: '30 5 * * *' });
  });

  it('purges with a cutoff exactly the configured number of days before now', async () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-10-09T05:30:00.000Z'));
    const { processor, repository } = setup(config(365));

    await processor.scheduledPurge();

    expect(repository.deleteCreatedBefore).toHaveBeenCalledWith(new Date('2025-10-09T05:30:00.000Z'));
  });

  it('records exactly one retention entry naming what it purged', async () => {
    const { processor, repository, recorded } = setup(config(365));
    repository.deleteCreatedBefore.mockResolvedValue(4);

    await processor.scheduledPurge();

    expect(recorded).toEqual([{
      key: 'system.audit.retention',
      resourceType: 'audit-entry',
      resourceId: 'all',
      projectId: null,
      summary: 'purged 4 audit entries',
    }]);
  });

  it('AC-8: does not call deleteCreatedBefore when auditDays is null', async () => {
    const { processor, repository } = setup(config(null));

    await processor.scheduledPurge();

    expect(repository.deleteCreatedBefore).not.toHaveBeenCalled();
  });

  it('AC-9: resolves without throwing when deleteCreatedBefore throws', async () => {
    const { processor, repository } = setup(config(365));
    repository.deleteCreatedBefore.mockRejectedValue(new Error('deadlock detected'));

    await expect(processor.scheduledPurge()).resolves.toBeUndefined();
  });

  it('AC-10: logs an error when deleteCreatedBefore throws', async () => {
    const { processor, repository } = setup(config(365));
    repository.deleteCreatedBefore.mockRejectedValue(new Error('deadlock detected'));

    const messages = await errorMessagesOf(() => processor.scheduledPurge());

    expect(messages).toContain('Audit retention purge failed, will retry next run: deadlock detected');
  });

  it('AC-11: resolves without throwing when its audit record call throws', async () => {
    const { processor, audit } = setup(config(365));
    audit.audited.mockRejectedValue(new Error('audit down'));

    await expect(processor.scheduledPurge()).resolves.toBeUndefined();
  });

  it('AC-12: logs an error when its audit record call throws', async () => {
    const { processor, audit } = setup(config(365));
    audit.audited.mockRejectedValue(new Error('audit down'));

    const messages = await errorMessagesOf(() => processor.scheduledPurge());

    expect(messages).toContain('Audit retention purge failed, will retry next run: audit down');
  });
});
