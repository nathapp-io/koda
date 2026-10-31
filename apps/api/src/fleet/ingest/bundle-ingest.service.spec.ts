import { Readable } from 'stream';
import { currentBookkeepingReason } from '../../action-context/audit-coverage';
import { currentContext, runWithActionContext, type ActionContext } from '../../action-context/action-context';
import { tarGz } from '../../../test/helpers/tar-gz';
import { BundleIngestService } from './bundle-ingest.service';

const now = new Date('2026-10-05T10:00:00Z');
const claim = (attempts: number) => ({ id: 'i1', artifactId: 'a1', jobId: 'j1', leaseEpoch: 1, attempts });

function make(attempts: number, opts: { expired?: boolean; storeFails?: boolean } = {}) {
  const repo = {
    claimNext: vi.fn().mockResolvedValueOnce(claim(attempts)).mockResolvedValue(null),
    findArtifact: vi.fn(async () => ({ storageKey: 'k', expiredAt: opts.expired ? now : null })),
    markRetry: vi.fn(), markFailed: vi.fn(), markOutcome: vi.fn(), replaceRows: vi.fn(),
  };
  const store = { get: vi.fn(async () => (opts.storeFails ? Promise.reject(new Error('EIO disk')) : Readable.from([Buffer.from('not gzip')]))) };
  const svc = new BundleIngestService(repo as never, store as never, {} as never, {} as never, {} as never, {} as never, { run: (fn: () => unknown) => fn() } as never, { upsertPrLinks: vi.fn() } as never, { onIngestCorrection: vi.fn() } as never, { emit: vi.fn() } as never,
    { record: vi.fn() } as never, { recordForJob: vi.fn().mockResolvedValue({ pending: 0 }) } as never,
  );
  return { svc, repo };
}

describe('BundleIngestService failure handling (spec §2.5)', () => {
  it('backs off 1 minute after the first failure', async () => {
    const { svc, repo } = make(0);
    await svc.ingestOne(now);
    expect(repo.markRetry).toHaveBeenCalledWith('i1', 1, new Date(now.getTime() + 60_000), expect.stringContaining(''));
  });

  it('uses the 4th backoff (2 h) after the 4th failure and fails on the 5th', async () => {
    const fourth = make(3);
    await fourth.svc.ingestOne(now);
    expect(fourth.repo.markRetry).toHaveBeenCalledWith('i1', 4, new Date(now.getTime() + 7_200_000), expect.any(String));
    const fifth = make(4);
    await fifth.svc.ingestOne(now);
    expect(fifth.repo.markFailed).toHaveBeenCalledWith('i1', 5, expect.any(String));
  });

  it('fails an expired bundle at once without retry', async () => {
    const { svc, repo } = make(0, { expired: true });
    await svc.ingestOne(now);
    expect(repo.markFailed).toHaveBeenCalledWith('i1', 1, 'bundle expired');
    expect(repo.markRetry).not.toHaveBeenCalled();
  });

  it('trims the stored error to 500 chars', async () => {
    const { svc, repo } = make(0, { storeFails: true });
    await svc.ingestOne(now);
    const error = repo.markRetry.mock.calls[0][3] as string;
    expect(error.length).toBeLessThanOrEqual(500);
    expect(error).toContain('EIO disk');
  });

  it('returns false when nothing is claimable', async () => {
    const { svc, repo } = make(0);
    repo.claimNext.mockReset().mockResolvedValue(null);
    await expect(svc.ingestOne(now)).resolves.toBe(false);
  });
});

/**
 * Permissions P2 US-004: `kick` starts a drain from a request (a runner's upload, an admin rerun), so the
 * drain — not the request — is the background entry: it runs as the `ingest` component with an id of its own.
 * A direct `drain` call keeps whatever context it was given.
 */
describe('BundleIngestService background context (US-004)', () => {
  /** A service whose `claimNext` records the context the drain reached it in, and finds nothing to ingest. */
  const recordingDrain = () => {
    const made = make(0);
    const seen: Array<ActionContext | undefined> = [];
    made.repo.claimNext.mockReset().mockImplementation(async () => {
      seen.push(currentContext());
      return null;
    });
    return { ...made, seen };
  };

  it('AC-6: a drain chained by kick runs as SYSTEM/ingest, not as the runner that kicked it', async () => {
    const { svc, seen } = recordingDrain();

    await runWithActionContext({ actor: { type: 'RUNNER', id: 'r1' }, origin: 'runner' }, () => {
      svc.kick();
      return svc.idle();
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.actor).toEqual({ type: 'SYSTEM', id: 'ingest' });
  });

  it('the kick-started drain takes a correlation id of its own instead of the kicking request\'s', async () => {
    const { svc, seen } = recordingDrain();

    await runWithActionContext(
      { actor: { type: 'RUNNER', id: 'r1' }, origin: 'runner', correlationId: 'c-runner' },
      () => {
        svc.kick();
        return svc.idle();
      },
    );

    expect(seen[0]?.correlationId).not.toBe('c-runner');
    expect(seen[0]?.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

/**
 * Permissions P2 US-007: the queue's own bookkeeping — the claim, the retry and failure marks — is uncounted, while
 * the rows the bundle parses into are the ingest's domain write and must stay counted.
 */
describe('BundleIngestService audit coverage (permissions P2 US-007)', () => {
  type Reason = ReturnType<typeof currentBookkeepingReason>;
  const JOB = {
    id: 'j1', leaseEpoch: 1, naxRunId: null, projectId: 'p1', repoId: 'r1', runnerId: 'rn', state: 'COMPLETED', command: 'PLAN',
    stateReason: null, finishResult: null, escalationReason: null, resultPrUrl: null, resultBranch: null, resultSha: null,
    costSpentUsd: '0', workflow: null,
  };

  /** A service whose repo calls each record the bookkeeping reason that was current when they were reached. */
  async function make(opts: { attempts?: number; expired?: boolean; storeFails?: boolean; body?: Buffer } = {}) {
    const seen: Record<'claimNext' | 'markRetry' | 'markFailed' | 'replaceRows', Reason[]> = {
      claimNext: [], markRetry: [], markFailed: [], replaceRows: [],
    };
    const repo = {
      claimNext: vi.fn(async () => { seen.claimNext.push(currentBookkeepingReason()); return claim(opts.attempts ?? 0); }),
      findArtifact: vi.fn(async () => ({ storageKey: 'k', expiredAt: opts.expired ? now : null })),
      markRetry: vi.fn(async () => { seen.markRetry.push(currentBookkeepingReason()); }),
      markFailed: vi.fn(async () => { seen.markFailed.push(currentBookkeepingReason()); }),
      markOutcome: vi.fn(),
      replaceRows: vi.fn(async () => { seen.replaceRows.push(currentBookkeepingReason()); }),
    };
    const body = opts.body ?? Buffer.from('not gzip');
    const store = { get: vi.fn(async () => (opts.storeFails ? Promise.reject(new Error('EIO disk')) : Readable.from([body]))) };
    const jobs = { lockById: vi.fn(async () => JOB), update: vi.fn(async () => JOB), appendEvent: vi.fn() };
    const svc = new BundleIngestService(
      repo as never, store as never, jobs as never, { event: vi.fn(() => ({})), publish: vi.fn() } as never,
      { record: vi.fn() } as never, { signal: vi.fn() } as never, { run: (fn: () => unknown) => fn() } as never,
      { upsertPrLinks: vi.fn() } as never, { onIngestCorrection: vi.fn() } as never, { emit: vi.fn() } as never,
      { record: vi.fn(async () => undefined) } as never,
      { recordForJob: vi.fn().mockResolvedValue({ pending: 0 }) } as never,
    );
    return { svc, repo, seen };
  }

  it('AC-4: ingestOne claims the next bundle while currentBookkeepingReason() answers fleet.ingest-queue', async () => {
    const { svc, repo, seen } = await make({ storeFails: true });

    await svc.ingestOne(now);

    expect(repo.claimNext).toHaveBeenCalledTimes(1);
    expect(seen.claimNext).toEqual(['fleet.ingest-queue']);
  });

  it('AC-5: a bundle read that throws marks a retry while currentBookkeepingReason() answers fleet.ingest-queue', async () => {
    const { svc, repo, seen } = await make({ attempts: 0, storeFails: true });

    await svc.ingestOne(now);

    // attempts 0 with an unexpired artifact is the retry branch, not the exhausted-attempt failure.
    expect(repo.markRetry).toHaveBeenCalledWith('i1', 1, expect.any(Date), expect.stringContaining('EIO disk'));
    expect(repo.markFailed).not.toHaveBeenCalled();
    expect(seen.markRetry).toEqual(['fleet.ingest-queue']);
  });

  it('AC-6: an ingesting claim writes its parsed rows while currentBookkeepingReason() answers undefined', async () => {
    const { svc, repo, seen } = await make({ body: await tarGz([{ name: 'workflow/result.json', body: '{"schemaVersion":1}' }]) });

    await svc.ingestOne(now);

    expect(repo.replaceRows).toHaveBeenCalledTimes(1);
    expect(repo.markRetry).not.toHaveBeenCalled();
    expect(seen.replaceRows).toEqual([undefined]);
  });

  it('marks an expired bundle failed while currentBookkeepingReason() answers fleet.ingest-queue', async () => {
    const { svc, repo, seen } = await make({ expired: true });

    await svc.ingestOne(now);

    expect(repo.markFailed).toHaveBeenCalledWith('i1', 1, 'bundle expired');
    expect(seen.markFailed).toEqual(['fleet.ingest-queue']);
  });

  it('leaves no reason current once ingestOne has resolved', async () => {
    const { svc } = await make({ storeFails: true });

    await svc.ingestOne(now);

    expect(currentBookkeepingReason()).toBeUndefined();
  });
});

describe('review event ingest', () => {
  async function review(opts: { pending?: number; epoch?: number; reject?: boolean; state?: string; command?: string } = {}) {
    const order: string[] = [];
    const job = {
      id: 'j1', projectId: 'p1', repoId: 'r1', leaseEpoch: opts.epoch ?? 1, command: opts.command ?? 'REVIEW',
      feature: 'review-pr-42', state: opts.state ?? 'COMPLETED', naxRunId: null, costSpentUsd: '0',
      stateReason: null, finishResult: null, escalationReason: null, resultPrUrl: null, resultBranch: null,
      resultSha: null, workflow: null,
    };
    const repo = {
      claimNext: vi.fn().mockResolvedValueOnce(claim(0)).mockResolvedValue(null),
      findArtifact: vi.fn().mockResolvedValue({ storageKey: 'k', expiredAt: null }),
      replaceRows: vi.fn(), markOutcome: vi.fn(), markRetry: vi.fn(), markFailed: vi.fn(),
    };
    const reviewEvents = { recordForJob: vi.fn(async () => {
      order.push('record');
      if (opts.reject) throw new Error('review storage failed');
      return { pending: opts.pending ?? 1 };
    }) };
    const events = { emit: vi.fn(() => { order.push('emit'); return true; }) };
    const body = await tarGz([{ name: 'nax-out/bot/pr-42/r1/bot-review.json', body: JSON.stringify({ version: 3, pr: { number: 42 }, trusted: true, events: [] }) }]);
    const svc = new BundleIngestService(
      repo as never, { get: async () => Readable.from([body]) } as never,
      { lockById: async () => job } as never, { event: () => ({}), publish: vi.fn() } as never,
      { record: vi.fn() } as never, { signal: vi.fn() } as never,
      { run: async (fn: () => Promise<unknown>) => { order.push('start'); const result = await fn(); order.push('commit'); return result; } } as never,
      { upsertPrLinks: vi.fn() } as never, { onIngestCorrection: vi.fn() } as never, events as never,
      { record: vi.fn() } as never, reviewEvents as never,
    );
    return { svc, repo, reviewEvents, events, order, job };
  }

  it('AC-11: records inside the transaction and emits once after commit', async () => {
    const t = await review();
    await t.svc.ingestOne(now);
    expect(t.repo.markRetry).not.toHaveBeenCalled();
    expect(t.reviewEvents.recordForJob).toHaveBeenCalledWith(t.job, 1, { outcome: 'done', trusted: true, events: [] });
    expect(t.events.emit).toHaveBeenCalledExactlyOnceWith('fleet.review.events-ingested', { jobId: 'j1' });
    expect(t.order).toEqual(['start', 'record', 'commit', 'emit']);
  });

  it('AC-12: no newly pending rows means no event', async () => {
    const t = await review({ pending: 0 });
    await t.svc.ingestOne(now);
    expect(t.reviewEvents.recordForJob).toHaveBeenCalledTimes(1);
    expect(t.repo.markOutcome).toHaveBeenCalled();
    expect(t.events.emit).not.toHaveBeenCalled();
  });

  it('AC-13: stale epoch never records or parses botReview', async () => {
    const t = await review({ epoch: 2 });
    await t.svc.ingestOne(now);
    expect(t.reviewEvents.recordForJob).not.toHaveBeenCalled();
    expect(t.repo.markOutcome).toHaveBeenCalledWith('i1', expect.objectContaining({ files: expect.not.objectContaining({ botReview: expect.anything() }) }));
    expect(t.events.emit).not.toHaveBeenCalled();
  });

  it('AC-14: a review row write failure retries the claim without publishing', async () => {
    const t = await review({ reject: true });
    await t.svc.ingestOne(now);
    expect(t.reviewEvents.recordForJob).toHaveBeenCalledTimes(1);
    expect(t.repo.markRetry).toHaveBeenCalledWith('i1', 1, new Date(now.getTime() + 60_000), 'review storage failed');
    expect(t.repo.markOutcome).not.toHaveBeenCalled();
    expect(t.events.emit).not.toHaveBeenCalled();
  });
});
