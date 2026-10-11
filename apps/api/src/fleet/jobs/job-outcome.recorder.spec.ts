import { FleetJobOutcomeRecorder } from './job-outcome.recorder';
import type { FleetJobRecord } from './domain/fleet-job.domain';

const job = (over: Partial<FleetJobRecord> = {}): FleetJobRecord => ({
  id: 'j1', projectId: 'p1', repoId: 'r1', feature: 'add', leaseEpoch: 2, state: 'FAILED', requestedById: 'u1', resultPrUrl: null,
  ...over,
} as FleetJobRecord);

describe('FleetJobOutcomeRecorder (S4a §2.4, D513)', () => {
  const repo = { findRepo: vi.fn(async () => ({ owner: 'acme', name: 'app' })) };
  const outbox = { record: vi.fn(async () => undefined) };
  const recorder = new FleetJobOutcomeRecorder(repo as never, outbox as never);
  afterEach(() => vi.clearAllMocks());

  it.each([
    ['ESCALATED', null, 'escalated'],
    ['FAILED', null, 'failed'],
    ['CRASHED', null, 'crashed'],
    ['COMPLETED', 'https://github.com/acme/app/pull/4', 'pr_opened'],
  ] as const)('enqueues %s as %s', async (state, pr, outcome) => {
    await recorder.onTerminal(job({ state, resultPrUrl: pr }));
    expect(outbox.record).toHaveBeenCalledWith({
      type: 'fleet_job_outcome',
      payload: { jobId: 'j1', leaseEpoch: 2, projectId: 'p1', requestedById: 'u1', outcome, repo: 'acme/app', feature: 'add', resultPrUrl: pr },
      metadata: { projectId: 'p1', eventId: 'j1:2' },
    });
  });

  it.each(['CANCELLED', 'COMPLETED', 'RUNNING'] as const)('enqueues nothing for %s without a PR', async (state) => {
    await recorder.onTerminal(job({ state }));
    expect(outbox.record).not.toHaveBeenCalled();
    expect(repo.findRepo).not.toHaveBeenCalled();
  });

  it('falls back to the repo id when the repo row is gone', async () => {
    repo.findRepo.mockResolvedValueOnce(null);
    await recorder.onTerminal(job());
    expect(outbox.record).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ repo: 'r1' }) }));
  });

  it('ingest: a late escalation wins over a late PR url', async () => {
    await recorder.onIngestCorrection(job({ state: 'ESCALATED', resultPrUrl: 'https://x/pull/1' }), { escalated: true, prFilled: true });
    expect(outbox.record).toHaveBeenCalledTimes(1);
    expect(outbox.record).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ outcome: 'escalated' }) }));
  });

  it('ingest: a late PR url on a COMPLETED job is pr_opened; nothing else enqueues', async () => {
    await recorder.onIngestCorrection(job({ state: 'COMPLETED', resultPrUrl: 'https://x/pull/1' }), { escalated: false, prFilled: true });
    expect(outbox.record).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ outcome: 'pr_opened' }) }));
    outbox.record.mockClear();
    await recorder.onIngestCorrection(job({ state: 'COMPLETED', resultPrUrl: null }), { escalated: false, prFilled: false });
    expect(outbox.record).not.toHaveBeenCalled();
  });
});
