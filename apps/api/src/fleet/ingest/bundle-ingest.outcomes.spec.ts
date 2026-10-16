import type { Mock } from 'vitest';
import { Readable } from 'stream';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BundleIngestService } from './bundle-ingest.service';
import { computeCorrection } from './ingest-corrections';
import { parseBundle } from './parse-bundle';
import { KnowledgeIndexQueue } from '../knowledge/knowledge-index.queue';
import { KNOWLEDGE_RUN_INGESTED, type KnowledgeRunIngestedEvent } from '../common/knowledge-events';
import { testFleetConfig } from '../../common/test-helpers/fleet-config';

vi.mock('./bundle-reader', () => ({ readBundleFiles: vi.fn(async () => ({})) }));
vi.mock('./parse-bundle', () => ({
  parseBundle: vi.fn(() => ({ naxRunId: null, rows: [], ledgerCostUsd: '0', runStatus: 'completed', finish: null, partial: false, files: [] })),
}));
vi.mock('./ingest-corrections', () => ({ computeCorrection: vi.fn() }));

const now = new Date('2026-10-09T10:00:00Z');

function make(updated: Record<string, unknown>) {
  const job = { id: 'j1', leaseEpoch: 1, naxRunId: null, projectId: 'p', repoId: 'r', runnerId: 'rn', state: 'COMPLETED', requestedById: 'u', resultPrUrl: null };
  const repo = {
    claimNext: vi.fn().mockResolvedValueOnce({ id: 'i1', artifactId: 'a1', jobId: 'j1', leaseEpoch: 1, attempts: 0 }).mockResolvedValue(null),
    findArtifact: vi.fn(async () => ({ storageKey: 'k', expiredAt: null })),
    replaceRows: vi.fn(), markOutcome: vi.fn(), markRetry: vi.fn(), markFailed: vi.fn(),
  };
  const store = { get: vi.fn(async () => Readable.from([])) };
  const jobs = { lockById: vi.fn(async () => job), update: vi.fn(async () => ({ ...job, ...updated })), appendEvent: vi.fn() };
  const live = { event: vi.fn(() => ({})), publish: vi.fn() };
  const order: string[] = [];
  const outcomes = { onIngestCorrection: vi.fn(async () => { order.push('outcome'); }) };
  const svc = new BundleIngestService(
    repo as never, store as never, jobs as never, live as never, { record: vi.fn() } as never, { signal: vi.fn() } as never,
    { run: async (fn: () => unknown) => { order.push('tx:start'); const r = await fn(); order.push('tx:end'); return r; } } as never,
    { upsertPrLinks: vi.fn().mockResolvedValue(undefined) } as never, outcomes as never, { emit: vi.fn() } as never,
  );
  return { svc, outcomes, repo, order };
}

describe('BundleIngestService notification outcomes (S4a §2.4, D513)', () => {
  it('reports a verdict correction to the recorder inside the ingest transaction', async () => {
    (computeCorrection as Mock).mockReturnValue({ patch: { state: 'ESCALATED' }, costRaised: false, escalated: true, liveCostUsd: null });
    const { svc, outcomes, order, repo } = make({ state: 'ESCALATED' });
    await svc.ingestOne(now);
    expect(repo.markRetry).not.toHaveBeenCalled();
    expect(outcomes.onIngestCorrection).toHaveBeenCalledWith(expect.objectContaining({ state: 'ESCALATED' }), { escalated: true, prFilled: false });
    expect(order).toEqual(['tx:start', 'outcome', 'tx:end']);
  });

  it('reports a late PR url', async () => {
    (computeCorrection as Mock).mockReturnValue({ patch: { resultPrUrl: 'https://x/pull/2' }, costRaised: false, escalated: false, liveCostUsd: null });
    const { svc, outcomes } = make({ resultPrUrl: 'https://x/pull/2' });
    await svc.ingestOne(now);
    expect(outcomes.onIngestCorrection).toHaveBeenCalledWith(expect.objectContaining({ resultPrUrl: 'https://x/pull/2' }), { escalated: false, prFilled: true });
  });

  it('does not call the recorder when the correction changed neither', async () => {
    (computeCorrection as Mock).mockReturnValue({ patch: {}, costRaised: false, escalated: false, liveCostUsd: null });
    const { svc, outcomes } = make({});
    await svc.ingestOne(now);
    expect(outcomes.onIngestCorrection).not.toHaveBeenCalled();
  });
});

/** S5b US-001: what the parser produced for a RUN bundle that carries workflow/feature-report.md. */
const reportRow = { kind: 'report', content: '# R' } as const;
const parsedWithReport = {
  naxRunId: 'run-1', runStatus: 'completed', workflow: null, workflowOutcome: null, workflowUrl: null,
  rows: { costEvents: [], stories: [], reviews: [], outcomes: [reportRow] },
  finish: null, files: {}, partial: false, ledgerCostUsd: '0',
};
const noCorrection = { patch: {}, costRaised: false, escalated: false, escalatedFrom: null, liveCostUsd: null };

function makeForCommand(command: string, events: { emit: (...args: never[]) => unknown } = { emit: vi.fn() }) {
  const job = {
    id: 'j1', leaseEpoch: 1, naxRunId: 'run-1', projectId: 'p', repoId: 'r', runnerId: 'rn', state: 'COMPLETED',
    command, requestedById: 'u', resultPrUrl: null, costSpentUsd: '0', stateReason: 'done', finishResult: null,
    escalationReason: null, resultBranch: null, resultSha: null, workflow: null,
  };
  const repo = {
    claimNext: vi.fn().mockResolvedValueOnce({ id: 'i1', artifactId: 'a1', jobId: 'j1', leaseEpoch: 1, attempts: 0 }).mockResolvedValue(null),
    findArtifact: vi.fn(async () => ({ storageKey: 'k', expiredAt: null })),
    replaceRows: vi.fn(), markOutcome: vi.fn(), markRetry: vi.fn(), markFailed: vi.fn(),
  };
  const store = { get: vi.fn(async () => Readable.from([])) };
  const jobs = { lockById: vi.fn(async () => job), update: vi.fn(async () => job), appendEvent: vi.fn() };
  // Records the transaction boundaries so a test can prove the post-commit hook fired after the commit.
  const order: string[] = [];
  const txManager = {
    run: async (fn: () => unknown) => { order.push('tx:start'); try { return await fn(); } finally { order.push('tx:end'); } },
  };
  const svc = new BundleIngestService(
    repo as never, store as never, jobs as never, { event: vi.fn(() => ({})), publish: vi.fn() } as never,
    { record: vi.fn() } as never, { signal: vi.fn() } as never, txManager as never,
    { upsertPrLinks: vi.fn() } as never, { onIngestCorrection: vi.fn() } as never, events as never,
  );
  return { svc, repo, events: events as { emit: Mock }, order };
}

describe('BundleIngestService run outcomes (S5b US-001 AC-10/AC-11)', () => {
  it('AC-10 writes the parsed outcome rows for a RUN job', async () => {
    (parseBundle as Mock).mockReturnValueOnce(parsedWithReport);
    (computeCorrection as Mock).mockReturnValueOnce(noCorrection);
    const { svc, repo } = makeForCommand('RUN');
    await svc.ingestOne(now);
    expect(repo.markRetry).not.toHaveBeenCalled();
    expect(repo.replaceRows).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'j1', leaseEpoch: 1, projectId: 'p', repoId: 'r' }),
      expect.objectContaining({ costEvents: [], stories: [], reviews: [], outcomes: [reportRow] }),
    );
  });

  it('AC-11 writes no outcome rows for a PLAN job', async () => {
    (parseBundle as Mock).mockReturnValueOnce(parsedWithReport);
    (computeCorrection as Mock).mockReturnValueOnce(noCorrection);
    const { svc, repo } = makeForCommand('PLAN');
    await svc.ingestOne(now);
    expect(repo.replaceRows).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ outcomes: [] }));
  });
});

/**
 * S5b US-004 (3c-2-D8): the ingest is the outcome pass's only trigger. It fires once per ingest, after the
 * transaction committed, and only for a RUN job — a rolled-back ingest queues nothing.
 */
/** A real emitter with the queue's handler on it, as `KnowledgeModule` subscribes it at bootstrap. */
function listeningTo(queue: KnowledgeIndexQueue): EventEmitter2 {
  const events = new EventEmitter2();
  events.on(KNOWLEDGE_RUN_INGESTED, (event: KnowledgeRunIngestedEvent) => queue.onRunIngested(event));
  return events;
}

describe('BundleIngestService outcome index trigger (S5b US-004)', () => {
  it('AC-8: emits one run-ingested event for a claimed RUN job, after the transaction resolved', async () => {
    (parseBundle as Mock).mockReturnValueOnce(parsedWithReport);
    (computeCorrection as Mock).mockReturnValueOnce(noCorrection);
    const { svc, events, order } = makeForCommand('RUN');
    events.emit.mockImplementation((_name: string, event: KnowledgeRunIngestedEvent) => { order.push(`emit:${event.jobId}`); });

    await svc.ingestOne(now);

    expect(events.emit).toHaveBeenCalledExactlyOnceWith(KNOWLEDGE_RUN_INGESTED, { jobId: 'j1' });
    expect(order).toEqual(['tx:start', 'tx:end', 'emit:j1']);
  });

  it('AC-8: never emits for a claimed PLAN job', async () => {
    (parseBundle as Mock).mockReturnValueOnce(parsedWithReport);
    (computeCorrection as Mock).mockReturnValueOnce(noCorrection);
    const { svc, events } = makeForCommand('PLAN');

    await svc.ingestOne(now);

    expect(events.emit).not.toHaveBeenCalled();
  });

  it('logs a warning when no listener heard the run-ingested event', async () => {
    (parseBundle as Mock).mockReturnValueOnce(parsedWithReport);
    (computeCorrection as Mock).mockReturnValueOnce(noCorrection);
    const warn = vi.spyOn(Logger.prototype, 'warn');
    warn.mockClear();
    const { svc } = makeForCommand('RUN', { emit: vi.fn(() => false) });

    await svc.ingestOne(now);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no listener for fleet.knowledge.run-ingested (job j1)'));
  });

  it('AC-9: a failing write never emits a run-ingested event', async () => {
    (parseBundle as Mock).mockReturnValueOnce(parsedWithReport);
    (computeCorrection as Mock).mockReturnValueOnce(noCorrection);
    const { svc, repo, events } = makeForCommand('RUN');
    repo.replaceRows.mockRejectedValue(new Error('boom'));

    await svc.ingestOne(now);

    expect(repo.markRetry).toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('AC-10: ingest through the real queue reaches indexOutcomes and never indexRepo', async () => {
    (parseBundle as Mock).mockReturnValueOnce(parsedWithReport);
    (computeCorrection as Mock).mockReturnValueOnce(noCorrection);
    const indexer = {
      indexRepo: vi.fn(async () => ({ status: 'indexed' })),
      indexOutcomes: vi.fn(async () => ({ status: 'indexed' })),
    };
    const queue = new KnowledgeIndexQueue(indexer as never, testFleetConfig({ knowledgeIndexEnabled: true }));
    const { svc } = makeForCommand('RUN', listeningTo(queue));

    await svc.ingestOne(now);

    await vi.waitFor(() => expect(indexer.indexOutcomes).toHaveBeenCalledExactlyOnceWith('j1'));
    expect(indexer.indexRepo).not.toHaveBeenCalled();
  });

  it('AC-10: the real queue is a no-op for ingest while indexing is off', async () => {
    (parseBundle as Mock).mockReturnValueOnce(parsedWithReport);
    (computeCorrection as Mock).mockReturnValueOnce(noCorrection);
    const indexer = {
      indexRepo: vi.fn(async () => ({ status: 'indexed' })),
      indexOutcomes: vi.fn(async () => ({ status: 'indexed' })),
    };
    const queue = new KnowledgeIndexQueue(indexer as never, testFleetConfig({ knowledgeIndexEnabled: false }));
    const { svc } = makeForCommand('RUN', listeningTo(queue));

    await svc.ingestOne(now);
    await new Promise((resolve) => setImmediate(resolve));

    expect(indexer.indexOutcomes).not.toHaveBeenCalled();
  });
});
