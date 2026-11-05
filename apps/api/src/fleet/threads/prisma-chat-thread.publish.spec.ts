import { ThreadEventBus } from '../../live/thread-event-bus';
import { mockAuditRecorder } from '../../common/test-helpers/global-stubs.module';
import { Prisma } from '../../generated/prisma/client';
import { PrismaChatThreadRepository } from './prisma-chat-thread.repository';

/**
 * Branch fix B1 (unit, fake Prisma): Publish is offered for a thread whose changes never went through write_doc.
 *
 * `writtenPaths` only counts the `write_doc` tool, and an `ask`/`full` turn edits the worktree through the agent's own
 * tools (native Write/Edit/Bash) — so a `read` thread needs a written path before a PUBLISH job is dispatched, and an
 * `ask`/`full` one does not: the runner publishes its own diff. No database.
 */

/** A sync this instant: `isRunnerOnline` reads the real clock, so an online runner is seen now, not at a fixed date. */
const seenNow = (): Date => new Date();

interface Opts {
  thread?: Partial<{
    id: string; projectId: string; kind: string; repoId: string; baseRef: string; feature: string; title: string;
    createdById: string; runnerId: string | null; status: string; mode: string; maxCostUsd: Prisma.Decimal;
    costUsd: Prisma.Decimal; specPath: string; skills: unknown[]; backend: unknown; writtenPaths: string[];
  }>;
  threadsEnabled?: boolean;
  runner?: { lastSeenAt: Date; protocolVersion: number; capabilities: unknown } | null;
  active?: { id: string; state: string; command: string; runnerId: string | null; leaseEpoch: number; action?: string } | null;
  /** Set to queue a THREAD_CLOSE at the active job's epoch (a closing session). */
  activeClosed?: boolean;
  budgetPaused?: boolean;
}

function publishRepo(opts: Opts = {}) {
  const thread = {
    id: 'T', projectId: 'P', kind: 'REPO', repoId: 'R', baseRef: 'trunk', feature: 'f', title: 'Publish test',
    createdById: 'U', runnerId: 'RN', status: 'ACTIVE', mode: 'read', maxCostUsd: new Prisma.Decimal('5'),
    costUsd: new Prisma.Decimal('0'), specPath: '.nax/features/f/spec.md', skills: [],
    backend: { kind: 'native', model: 'm1' }, writtenPaths: [],
    ...opts.thread,
  };
  const runner = opts.runner === undefined
    ? { lastSeenAt: seenNow(), protocolVersion: 4, capabilities: { threadWrite: true } }
    : opts.runner;
  const active = opts.active ?? null;
  const created: Array<{ data: unknown }> = [];
  const commands: Array<Record<string, unknown>> = [];
  const prisma = {
    client: {
      chatThread: { findFirst: vi.fn(async () => (opts.thread === null ? null : thread)) },
      fleetJob: { findFirst: vi.fn(async () => (active
        // The live job's requester: the caller who started the turn (permissions P1's `assertOwnLiveSession`).
        ? { requestedById: thread.createdById, requestedByType: 'USER', ...active, threadTurn: { action: active.action ?? null } }
        : null)) },
      fleetThreadTurn: { findFirst: vi.fn(async () => null), create: vi.fn(async (args: { data: unknown }) => { created.push(args); return {}; }) },
      fleetRepo: { findUnique: vi.fn(async () => ({ owner: 'acme', name: 'app' })) },
      runner: { findUnique: vi.fn(async () => runner) },
      chatMessage: { findFirst: vi.fn(async () => null) },
      fleetCommand: { findFirst: vi.fn(async () => (opts.activeClosed ? { id: 'close' } : null)) },
      $queryRaw: vi.fn(async () => []),
    },
  };
  const jobs = {
    lockById: vi.fn(async () => undefined),
    createJob: vi.fn(async (input: Record<string, unknown>) => ({ id: 'PJ', ...input })),
    appendEvent: vi.fn(async () => undefined),
    createCommand: vi.fn(async (input: Record<string, unknown>) => { commands.push(input); return {}; }),
  };
  const txManager = { run: vi.fn(async (fn: () => Promise<unknown>) => fn()) };
  const budgets = { snapshot: vi.fn(async () => ({ match: () => (opts.budgetPaused ? { id: 'bp', scopeType: 'global' } : null), runnerPaused: () => false })) };
  const placement = { placeJob: vi.fn(async () => ({ assigned: false })) };
  const notifier = { notify: vi.fn() };
  const activity = { record: vi.fn(async () => undefined) };
  const repo = new PrismaChatThreadRepository(
    prisma as never, jobs as never, txManager as never, activity as never, placement as never, notifier as never, budgets as never,
    { threadsEnabled: opts.threadsEnabled ?? true, runnerOfflineSec: 90 } as never,
    mockAuditRecorder, new ThreadEventBus(),
  );
  return { repo, prisma, jobs, created, commands, placement, notifier };
}

describe('PrismaChatThreadRepository.publish and code-only ask/full changes (B1)', () => {
  it('B1: a read thread with no written path still refuses as nothingToPublish and creates no job', async () => {
    const { repo, jobs } = publishRepo({ thread: { mode: 'read', writtenPaths: [] } });
    await expect(repo.publish('P', 'T', 'U')).rejects.toMatchObject({ prefix: 'threads.nothingToPublish' });
    expect(jobs.createJob).not.toHaveBeenCalled();
  });

  it('B1: an ask thread with no written path creates the PUBLISH job (the agent edits through its own tools)', async () => {
    const { repo, jobs, created, placement } = publishRepo({ thread: { mode: 'ask', writtenPaths: [] } });
    await expect(repo.publish('P', 'T', 'U')).resolves.toEqual({ jobId: 'PJ' });
    expect(jobs.createJob).toHaveBeenCalledWith(expect.objectContaining({ command: 'THREAD', threadId: 'T', maxCostUsd: '0' }));
    expect(created[0]?.data).toMatchObject({ action: 'PUBLISH', mode: 'ask', initialMessageId: null, resume: false });
    expect(placement.placeJob).toHaveBeenCalledWith('PJ');
  });

  it('B1: a full thread with no written path creates the PUBLISH job', async () => {
    const { repo, jobs, created } = publishRepo({ thread: { mode: 'full', writtenPaths: [] } });
    await expect(repo.publish('P', 'T', 'U')).resolves.toEqual({ jobId: 'PJ' });
    expect(jobs.createJob).toHaveBeenCalledTimes(1);
    expect(created[0]?.data).toMatchObject({ action: 'PUBLISH', mode: 'full' });
  });

  it('B1: a full thread publishes into an idle live session with no written path (THREAD_PUBLISH, no new job)', async () => {
    const { repo, jobs, commands, notifier } = publishRepo({
      thread: { mode: 'full', writtenPaths: [] },
      active: { id: 'SJ', state: 'RUNNING', command: 'THREAD', runnerId: 'RN', leaseEpoch: 7, action: 'SESSION' },
    });
    await expect(repo.publish('P', 'T', 'U')).resolves.toEqual({ jobId: null });
    expect(jobs.createJob).not.toHaveBeenCalled();
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ jobId: 'SJ', type: 'THREAD_PUBLISH', leaseEpoch: 7, payload: {} });
    expect(notifier.notify).toHaveBeenCalledWith('RN');
  });

  it('B1: a read thread with a written path keeps creating the PUBLISH job', async () => {
    const { repo, jobs } = publishRepo({ thread: { mode: 'read', writtenPaths: ['docs/a.md'] } });
    await expect(repo.publish('P', 'T', 'U')).resolves.toEqual({ jobId: 'PJ' });
    expect(jobs.createJob).toHaveBeenCalledTimes(1);
  });

  it('B1: a read thread with no written path refuses before the runner and budget reads', async () => {
    const { repo, prisma } = publishRepo({ thread: { mode: 'read', writtenPaths: [] } });
    await expect(repo.publish('P', 'T', 'U')).rejects.toMatchObject({ prefix: 'threads.nothingToPublish' });
    // The guard is still the last refusal before a job exists, so it runs after the runner checks: the message is the
    // same one the page shows, never runnerOffline or nothingToPublish confusion.
    expect(prisma.client.runner.findUnique).toHaveBeenCalled();
  });
});
