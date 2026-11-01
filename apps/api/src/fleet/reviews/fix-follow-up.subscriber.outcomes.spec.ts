import { Logger } from '@nestjs/common';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { ValidationAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { BudgetPausedException } from '../budgets/budget.exceptions';
import { FleetDispatchException } from '../jobs/fleet-dispatch.exception';
import { FixFollowUpSubscriber } from './fix-follow-up.subscriber';
import { buildFixFollowUpPayload } from '../common/fix-follow-up-events';
import type { FleetPrReviewRecord } from './domain/fleet-pr-review.domain';
import { FanOutPublisher } from '../../outbox/fan-out-publisher';
import { noopLastErrors } from '../../../test/helpers/outbox-record';
import type { AuditRecordInput } from '../../audit/audit-recorder.service';

const claim = { id: 'claim-1', repoId: 'r1', prNumber: 22, headSha: 'a'.repeat(40), jobId: null, outcome: 'pending', createdAt: new Date(0), updatedAt: new Date(0) } as FleetPrReviewRecord;
function setup(error?: unknown) {
  const audits: AuditRecordInput[] = [];
  const reviews = {
    findPrincipalAccess: vi.fn(async () => ({ exists: true, disabled: false })),
    insertPending: vi.fn(async () => claim), markDispatched: vi.fn(async () => undefined),
    remove: vi.fn(async (_id: string) => undefined), markFailed: vi.fn(async (_id: string, _outcome: string) => undefined),
  };
  const jobs = { dispatch: vi.fn(async () => { if (error !== undefined) throw error; return { job: { id: 'review-1' } }; }) };
  const audit = { record: vi.fn(async (entry: AuditRecordInput) => { audits.push(entry); }) };
  const txManager = { run: vi.fn(async <T>(fn: () => Promise<T>) => fn()), getClient: vi.fn(), isInTransaction: vi.fn(() => false) };
  const subscriber = new FixFollowUpSubscriber(new FanOutPublisher(noopLastErrors), reviews as never, jobs as never,
    { findReviewRepo: vi.fn(async () => ({ id: 'r1' })) } as never,
    { effectiveKeys: vi.fn(async () => new Set(['fleet.job.dispatch'])) } as never, audit as never, txManager as never);
  const payload = buildFixFollowUpPayload({ id: 'fix-42', projectId: 'p1', repoId: 'r1', requestedById: 'u1', requestedByType: 'USER', leaseEpoch: 3, profiles: [], maxCostUsd: '1.0000' } as never, 22, 'a'.repeat(40));
  return { subscriber, reviews, jobs, audit, audits, payload };
}
const paused = () => new BudgetPausedException({ id: 'b1', scopeType: 'PROJECT', scopeId: 'p1', scopeKey: 'p1' });
const cases = [
  [paused(), 'remove', 'follow-up review skipped: budget_paused'],
  [new ConflictAppException({}, 'fleet.jobs'), 'remove', 'follow-up review skipped: review_active'],
  [new Error('boom'), 'remove', 'follow-up review skipped: dispatch_error'],
] as const;
describe('FixFollowUpSubscriber dispatch outcomes', () => {
  it.each(cases)('maps removal outcome %s', async (error, _kind, summary) => {
    const s = setup(error); await s.subscriber.handle(s.payload);
    expect({ removed: s.reviews.remove.mock.calls.map(([id]) => id), summary: s.audits[0]?.summary }).toEqual({ removed: ['claim-1'], summary });
  });
  it.each([
    [new ValidationAppException({ reason: 'review is GitHub-only' }, 'fleet.dispatchInput'), 'review is GitHub-only'],
    [new NotFoundAppException({}, 'fleet.repos'), 'NotFoundAppException'],
    [new FleetDispatchException('disabled'), 'FleetDispatchException'],
  ] as const)('maps permanent refusal %s', async (error, reason) => {
    const s = setup(error); await s.subscriber.handle(s.payload);
    expect({ failed: s.reviews.markFailed.mock.calls[0], summary: s.audits[0]?.summary }).toEqual({ failed: ['claim-1', `failed:${reason}`], summary: `follow-up review skipped: ${reason}` });
  });
  it('does not mark a budget pause failed', async () => { const s = setup(paused()); await s.subscriber.handle(s.payload); expect(s.reviews.markFailed).not.toHaveBeenCalled(); });
  it('truncates failed outcome to 200 characters', async () => {
    const s = setup(new ValidationAppException({ reason: 'x'.repeat(300) }, 'fleet.dispatchInput')); await s.subscriber.handle(s.payload);
    const outcome = s.reviews.markFailed.mock.calls[0]?.[1]; expect(outcome).toHaveLength(200); expect(outcome?.startsWith('failed:')).toBe(true);
  });
  it('warns with FIX job id and error class and resolves unexpected dispatch errors', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try { const s = setup(new Error('boom')); warn.mockClear(); await expect(s.subscriber.handle(s.payload)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1); expect(warn.mock.calls[0]?.[0]).toContain('fix-42'); expect(warn.mock.calls[0]?.[0]).toContain('Error');
    } finally { warn.mockRestore(); }
  });
  it.each([new ConflictAppException({}, 'fleet.jobs'), new Error('dispatch failed')])('propagates removal failures for retryable dispatch failures', async (dispatchError) => {
    const s = setup(dispatchError); s.reviews.remove.mockRejectedValue(new Error('remove db'));
    await expect(s.subscriber.handle(s.payload)).rejects.toThrow('remove db');
  });
  it('propagates cleanup and audit persistence failures but catches dispatch failures', async () => {
    const s = setup(paused()); s.reviews.remove.mockRejectedValue(new Error('remove db'));
    await expect(s.subscriber.handle(s.payload)).rejects.toThrow('remove db');
    const mark = setup(new ValidationAppException({ reason: 'no' }, 'fleet.dispatchInput')); mark.reviews.markFailed.mockRejectedValue(new Error('mark db'));
    await expect(mark.subscriber.handle(mark.payload)).rejects.toThrow('mark db');
    const audit = setup(new Error('dispatch db')); audit.audit.record.mockRejectedValue(new Error('audit db'));
    await expect(audit.subscriber.handle(audit.payload)).rejects.toThrow('audit db');
    expect(audit.audit.record).toHaveBeenCalledWith(expect.objectContaining({ resourceId: 'fix-42', summary: 'follow-up review skipped: dispatch_error' }));
    const failedAudit = setup(new ValidationAppException({ reason: 'refused' }, 'fleet.dispatchInput'));
    failedAudit.audit.record.mockRejectedValue(new Error('audit after mark db'));
    await expect(failedAudit.subscriber.handle(failedAudit.payload)).rejects.toThrow('audit after mark db');
  });
});
