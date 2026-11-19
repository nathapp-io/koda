import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuditRecordInput } from '../audit/audit-recorder.service';
import type { IRetentionConfig } from '../config/retention.config';
import { SYSTEM_WRITER_METADATA } from '../permissions/system-writer.decorator';
import { ApprovalRetentionProcessor } from './approval-retention.processor';

const config = (approvalDays: number | null): IRetentionConfig => ({
  webhookDeliveryDays: 30,
  approvalDays,
  auditDays: 365,
});

/** The processor, its collaborators and the entries the recorder would have written. */
function setup(retention: IRetentionConfig | undefined) {
  const repository = { deleteSettledBefore: vi.fn().mockResolvedValue(0) };
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
  const processor = new ApprovalRetentionProcessor(repository as never, configService as never, audit as never);
  return { processor, repository, configService, audit, recorded };
}

/** The error messages the processor logged during `fn`, isolated from earlier tests in this file. */
async function errorMessagesOf(fn: () => Promise<void>): Promise<unknown[]> {
  const errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  errorLog.mockClear();

  await fn();

  return errorLog.mock.calls.map((call) => call[0]);
}

describe('ApprovalRetentionProcessor (US-003)', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('declares the approval retention system writer key', () => {
    expect(Reflect.getMetadata(SYSTEM_WRITER_METADATA, ApprovalRetentionProcessor)).toBe('system.approval.retention');
  });

  it('runs nightly at 05:15, between the webhook delivery and audit purges', () => {
    const { processor } = setup(config(180));
    const cronOptions = new Reflector().get('SCHEDULE_CRON_OPTIONS', processor.scheduledPurge);
    expect(cronOptions).toMatchObject({ cronTime: '15 5 * * *' });
  });

  it('AC-7: purges with a cutoff exactly the configured number of days before now', async () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-11-19T05:15:00.000Z'));
    const { processor, repository } = setup(config(180));

    await processor.scheduledPurge();

    expect(repository.deleteSettledBefore).toHaveBeenCalledWith(new Date('2026-05-23T05:15:00.000Z'));
  });

  it('AC-8: records exactly one retention entry naming what it purged', async () => {
    const { processor, repository, recorded } = setup(config(180));
    repository.deleteSettledBefore.mockResolvedValue(3);

    await processor.scheduledPurge();

    expect(recorded).toEqual([{
      key: 'system.approval.retention',
      resourceType: 'approval-request',
      resourceId: 'all',
      projectId: null,
      summary: 'purged 3 settled approval requests',
    }]);
  });

  it('AC-8: records nothing when the purge deletes no request', async () => {
    const { processor, recorded } = setup(config(180));

    await processor.scheduledPurge();

    expect(recorded).toEqual([]);
  });

  it('AC-9: resolves without throwing when deleteSettledBefore throws', async () => {
    const { processor, repository } = setup(config(180));
    repository.deleteSettledBefore.mockRejectedValue(new Error('deadlock detected'));

    await expect(processor.scheduledPurge()).resolves.toBeUndefined();
  });

  it('AC-10: logs an error when deleteSettledBefore throws', async () => {
    const { processor, repository } = setup(config(180));
    repository.deleteSettledBefore.mockRejectedValue(new Error('deadlock detected'));

    const messages = await errorMessagesOf(() => processor.scheduledPurge());

    expect(messages).toContain('Approval retention purge failed, will retry next run: deadlock detected');
  });

  it('AC-12: records no audit entry when deleteSettledBefore throws', async () => {
    const { processor, repository, recorded } = setup(config(180));
    repository.deleteSettledBefore.mockRejectedValue(new Error('deadlock detected'));

    await processor.scheduledPurge();

    expect(recorded).toEqual([]);
  });

  it('AC-12: records no audit entry when its own record call throws, and resolves', async () => {
    const { processor, audit, recorded } = setup(config(180));
    audit.audited.mockRejectedValue(new Error('audit down'));

    await expect(processor.scheduledPurge()).resolves.toBeUndefined();
    expect(recorded).toEqual([]);
  });

  it('AC-13: does not call deleteSettledBefore when approvalDays is null', async () => {
    const { processor, repository } = setup(config(null));

    await processor.scheduledPurge();

    expect(repository.deleteSettledBefore).not.toHaveBeenCalled();
  });

  it('does nothing when the retention config is absent', async () => {
    const { processor, repository } = setup(undefined);

    await processor.scheduledPurge();

    expect(repository.deleteSettledBefore).not.toHaveBeenCalled();
  });

  /**
   * The purge's predicate is `status IN (settled) AND updatedAt < cutoff`; the index has to answer
   * both halves, and the schema the tests build with `db push` must be the one a migration ships.
   */
  it('ships the (status, updatedAt) index in the schema and in a migration', () => {
    const root = join(__dirname, '../..');
    const schema = readFileSync(join(root, 'prisma/schema.prisma'), 'utf8');
    const model = schema.match(/model ApprovalRequest \{([\s\S]*?)\n\}/)?.[1];
    expect(model).toContain('@@index([status, updatedAt])');

    const sql = readFileSync(
      join(root, 'prisma/migrations/20261119120000_approval_request_status_updated_index/migration.sql'),
      'utf8',
    );
    expect(sql).toContain('CREATE INDEX "ApprovalRequest_status_updatedAt_idx" ON "ApprovalRequest"("status", "updatedAt");');
  });
});
