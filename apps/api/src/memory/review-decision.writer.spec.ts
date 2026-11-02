import { reviewDecisionObject, ReviewDecisionWriter, type ReviewDecisionInput } from './review-decision.writer';
import { runAsSystem, runWithApproval } from '../action-context/action-context';
import { PERMISSION_CATALOG } from '../permissions/catalog';

const text = { finding: 'missing null check', reason: 'guarded upstream' };
describe('reviewDecisionObject', () => {
  it('AC-1: includes file and line', () => {
    expect(reviewDecisionObject({ ...text, file: 'src/a.ts', line: 12 })).toBe('Not a defect: missing null check. Reason: guarded upstream (src/a.ts:12)');
  });
  it('AC-2: includes a file without a line', () => {
    expect(reviewDecisionObject({ ...text, file: 'src/a.ts' })).toBe('Not a defect: missing null check. Reason: guarded upstream (src/a.ts)');
  });
  it('AC-3: omits absent location', () => {
    expect(reviewDecisionObject(text)).toBe('Not a defect: missing null check. Reason: guarded upstream');
    expect(reviewDecisionObject({ ...text, line: 12 })).toBe(reviewDecisionObject(text));
  });
  it('AC-12: declares the system key', () => {
    expect(PERMISSION_CATALOG.find(({ key }) => key === 'system.review.decision')).toMatchObject({ access: 'system', scope: 'any' });
  });
});

describe('ReviewDecisionWriter audit provenance', () => {
  const input: ReviewDecisionInput = {
    projectId: 'p1', repoId: 'r1', prNumber: 42, jobId: 'j1', threadId: 't1',
    findingKey: 'f-1', finding: 'missing null check', reason: 'guarded upstream',
  };

  /** The mint's audit entry, with the repository and the recorder mocked so no database is needed. */
  const auditSummary = async (satisfiedBy: 'human' | 'none'): Promise<string> => {
    const repo = { upsert: vi.fn(async (_item: unknown, options: { onWritten: (written: { item: { id: string }; superseded: null }) => Promise<void> }) => {
      await options.onWritten({ item: { id: 'm1' }, superseded: null });
      return { id: 'm1' };
    }) };
    const audit = { record: vi.fn<(entry: { summary: string }) => Promise<void>>(async () => undefined) };
    const writer = new ReviewDecisionWriter(repo as never, audit as never);
    const approval = { requiredMode: 'human' as const, satisfiedBy, approverType: 'FORGE_USER' as const, approverId: 'github:alice' };
    await runAsSystem('review', () => runWithApproval(approval, () => writer.mint(input)));
    expect(audit.record).toHaveBeenCalledTimes(1);
    return audit.record.mock.calls[0][0].summary;
  };

  it('US-007 AC-20: an unverified approver is recorded as such', async () => {
    expect(await auditSummary('none')).toContain('approver github:alice (unverified)');
  });

  it('US-007: a verified approver is recorded as a thread author', async () => {
    expect(await auditSummary('human')).toContain('approver github:alice (verified thread author)');
  });
});
