import { Readable } from 'stream';
import { currentContext, runWithActionContext, type ActionContext } from '../../action-context/action-context';
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
  const svc = new BundleIngestService(repo as never, store as never, {} as never, {} as never, {} as never, {} as never, { run: (fn: () => unknown) => fn() } as never, { upsertPrLinks: vi.fn() } as never, { onIngestCorrection: vi.fn() } as never, { emit: vi.fn() } as never);
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
