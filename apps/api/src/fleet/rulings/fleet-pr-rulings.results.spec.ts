import { FleetPrRulingsService } from './fleet-pr-rulings.service';
import type { BotReviewParse, CallerRulings } from '../ingest/parsers/bot-review.parser';

function setup() {
  const job = { id: 'fix', repoId: 'repo', feature: 'review-pr-12', fixReady: null, prRulings: { headSha: 'a'.repeat(40), rulings: [
    { rulingId: 'r1', item: 'D-1' }, { rulingId: 'r2', item: 'G-1' },
  ] } };
  const repo = {
    settlePending: vi.fn(async (id: string) => ({ jobId: 'run', id })),
    runsForPr: vi.fn(async () => ['run', 'run2']),
  };
  const effects = { commentOnRulingResult: vi.fn(), commentOnReady: vi.fn() };
  const svc = new FleetPrRulingsService(repo as never, {} as never, {} as never, effects as never, {} as never);
  const record = (callerRulings?: CallerRulings) => svc.recordResults(job as never, { outcome: 'done', trusted: true, events: [], ...(callerRulings ? { callerRulings } : {}) });
  return { repo, effects, job, svc, record };
}

describe('FIX ruling results', () => {
  it('AC-4 reconciles sent ids only and formats the summary', async () => {
    const { record, repo, effects } = setup();
    await record({ applied: [{ item: 'D-1', disposition: 'confirmed' }, { item: 'unsent', disposition: 'waived' }], skipped: [{ item: 'G-1', reason: 'superseded-by-writer' }] });
    expect(repo.settlePending.mock.calls).toEqual([
      ['r1', 'repo', { state: 'applied', appliedJobId: 'fix', skipReason: null }],
      ['r2', 'repo', { state: 'skipped', appliedJobId: 'fix', skipReason: 'superseded-by-writer' }],
    ]);
    expect(effects.commentOnRulingResult).toHaveBeenCalledExactlyOnceWith('run', 'Finish fix: applied D-1 (confirmed); skipped G-1 (superseded-by-writer)');
  });
  it.each(['echo-failed', 'recorder-failed'])('AC-5/9 leaves %s pending without summary', async (reason) => {
    const { record, repo, effects } = setup();
    await record({ applied: [], skipped: [{ item: 'G-1', reason }] });
    expect(repo.settlePending).not.toHaveBeenCalled(); expect(effects.commentOnRulingResult).not.toHaveBeenCalled();
  });
  it('AC-6 untrusted-pr skips all sent rulings', async () => {
    const { record, repo } = setup(); await record({ applied: [], skipped: [], ignored: 'untrusted-pr' });
    expect(repo.settlePending).toHaveBeenCalledTimes(2);
    expect(repo.settlePending).toHaveBeenCalledWith('r2', 'repo', { state: 'skipped', appliedJobId: 'fix', skipReason: 'untrusted-pr' });
  });
  it.each([undefined, { applied: [{ item: 'D-1', disposition: 'confirmed' }], skipped: [], ignored: 'head-mismatch' } as CallerRulings])('AC-7/8 missing or head-mismatch changes nothing', async (caller) => {
    const { record, repo, effects } = setup(); await record(caller);
    expect(repo.settlePending).not.toHaveBeenCalled(); expect(effects.commentOnRulingResult).not.toHaveBeenCalled();
  });
  it('AC-10 a replaced snapshot id produces no summary or replacement write', async () => {
    const { record, repo, effects } = setup(); repo.settlePending.mockResolvedValue(null as never);
    await record({ applied: [{ item: 'D-1', disposition: 'confirmed' }], skipped: [] });
    expect(repo.settlePending).toHaveBeenCalledExactlyOnceWith('r1', 'repo', { state: 'applied', appliedJobId: 'fix', skipReason: null });
    expect(effects.commentOnRulingResult).not.toHaveBeenCalled();
  });
  it.each([{ outcome: 'absent' }, { outcome: 'invalid', reason: 'artifact-invalid' }] as BotReviewParse[])('does not reconcile a non-done artifact', async (parse) => {
    const { svc, job, repo } = setup(); await svc.recordResults(job as never, parse);
    expect(repo.settlePending).not.toHaveBeenCalled();
  });
  it('reports ready to every matching RUN even without an artifact', async () => {
    const { svc, job, repo, effects } = setup();
    await svc.recordResults({ ...job, fixReady: { markedReady: true } } as never, { outcome: 'absent' });
    expect(repo.runsForPr).toHaveBeenCalledWith('repo', 12);
    expect(effects.commentOnReady.mock.calls).toEqual([['run', 'PR #12 marked ready by FIX fix'], ['run2', 'PR #12 marked ready by FIX fix']]);
  });
});
