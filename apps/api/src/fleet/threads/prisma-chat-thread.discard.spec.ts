import { mockAuditRecorder } from '../../common/test-helpers/global-stubs.module';
import { Prisma } from '../../generated/prisma/client';
import { PrismaChatThreadRepository } from './prisma-chat-thread.repository';

/**
 * US-004 discard (unit, fake Prisma). Each test drives the real `discard()` and asserts one refusal in the brief's
 * order, or the happy path that creates the DISCARD job. No database.
 */

/** A sync this instant: `isRunnerOnline` reads the real clock, so an online runner is seen now, not at a fixed date. */
const seenNow = (): Date => new Date();

interface Opts {
  thread?: Partial<{ id: string; projectId: string; repoId: string; baseRef: string; feature: string; title: string; createdById: string; runnerId: string | null; status: string; maxCostUsd: Prisma.Decimal; costUsd: Prisma.Decimal; specPath: string; skills: unknown[]; backend: unknown; writtenPaths: string[] }>;
  threadsEnabled?: boolean;
  runner?: { lastSeenAt: Date; protocolVersion: number; capabilities: unknown } | null;
  active?: { id: string; state: string; command: string; runnerId: string | null; leaseEpoch: number; action?: string } | null;
  budgetPaused?: boolean;
}

function discardRepo(opts: Opts = {}) {
  const thread = {
    id: 'T', projectId: 'P', repoId: 'R', baseRef: 'trunk', feature: 'f', title: 'Discard test', createdById: 'U',
    runnerId: 'RN', status: 'ACTIVE', maxCostUsd: new Prisma.Decimal('5'), costUsd: new Prisma.Decimal('0'),
    specPath: '.nax/features/f/spec.md', skills: [], backend: { kind: 'native', model: 'm1' }, writtenPaths: [],
    ...opts.thread,
  };
  const runner = opts.runner === undefined
    ? { lastSeenAt: seenNow(), protocolVersion: 4, capabilities: { threadWrite: true } }
    : opts.runner;
  const active = opts.active ?? null;
  const created: Array<{ data: unknown }> = [];
  const prisma = {
    client: {
      chatThread: { findFirst: vi.fn(async () => (opts.thread === null ? null : thread)) },
      fleetJob: { findFirst: vi.fn(async () => (active ? { ...active, threadTurn: { action: active.action ?? null } } : null)) },
      fleetThreadTurn: { findFirst: vi.fn(async () => null), create: vi.fn(async (args: { data: unknown }) => { created.push(args); return {}; }) },
      fleetRepo: { findUnique: vi.fn(async () => ({ owner: 'acme', name: 'app' })) },
      runner: { findUnique: vi.fn(async () => runner) },
      chatMessage: { findFirst: vi.fn(async () => null) },
      $queryRaw: vi.fn(async () => []),
    },
  };
  const jobs = {
    lockById: vi.fn(async () => undefined),
    createJob: vi.fn(async (input: Record<string, unknown>) => ({ id: 'DJ', ...input })),
    appendEvent: vi.fn(async () => undefined),
    createCommand: vi.fn(async () => ({})),
  };
  const txManager = { run: vi.fn(async (fn: () => Promise<unknown>) => fn()) };
  const budgets = { snapshot: vi.fn(async () => ({ match: () => (opts.budgetPaused ? { id: 'bp', scopeType: 'global' } : null), runnerPaused: () => false })) };
  const placement = { placeJob: vi.fn(async () => ({ assigned: false })) };
  const notifier = { notify: vi.fn() };
  const activity = { record: vi.fn(async () => undefined) };
  const repo = new PrismaChatThreadRepository(
    prisma as never, jobs as never, txManager as never, activity as never, placement as never, notifier as never, budgets as never,
    { threadsEnabled: opts.threadsEnabled ?? true, runnerOfflineSec: 90 } as never,
    mockAuditRecorder,
  );
  return { repo, prisma, jobs, created, placement, notifier };
}

describe('PrismaChatThreadRepository.discard (US-004)', () => {
  it('AC-1: creates a THREAD job whose turn is DISCARD with no initial message and no resume', async () => {
    const { repo, created } = discardRepo();
    await repo.discard('P', 'T', 'U');
    expect(created).toHaveLength(1);
    expect(created[0]?.data).toMatchObject({ action: 'DISCARD', initialMessageId: null, resume: false });
  });

  it('AC-1: returns the new job id and places it after commit', async () => {
    const { repo, placement } = discardRepo();
    const result = await repo.discard('P', 'T', 'U');
    expect(result).toEqual({ jobId: 'DJ' });
    expect(placement.placeJob).toHaveBeenCalledWith('DJ');
  });

  it('creates the job with a zero cost cap (createThreadJob sets it to 0 for DISCARD)', async () => {
    const { repo, jobs } = discardRepo();
    await repo.discard('P', 'T', 'U');
    expect(jobs.createJob).toHaveBeenCalledWith(expect.objectContaining({ command: 'THREAD', maxCostUsd: '0', threadId: 'T' }));
  });

  it('AC-7: refuses a project member who is not the creator with 403 permissions when canOperate is false', async () => {
    const { repo, jobs } = discardRepo();
    await expect(repo.discard('P', 'T', 'someone-else')).rejects.toMatchObject({ prefix: 'permissions', httpStatus: 403 });
    expect(jobs.createJob).not.toHaveBeenCalled();
  });

  it('US-002: an any-row key holder discards another creator\'s thread when canOperate is true', async () => {
    const { repo, jobs } = discardRepo();
    await expect(repo.discard('P', 'T', 'someone-else', true)).resolves.toEqual({ jobId: 'DJ' });
    expect(jobs.createJob).toHaveBeenCalledWith(expect.objectContaining({ requestedById: 'someone-else', requestedByType: 'USER' }));
  });

  it('US-002: the creator still discards its own thread with canOperate false', async () => {
    const { repo, jobs } = discardRepo();
    await expect(repo.discard('P', 'T', 'U', false)).resolves.toEqual({ jobId: 'DJ' });
    expect(jobs.createJob).toHaveBeenCalledTimes(1);
  });

  it('answers 404 threads.notFound for an unknown thread', async () => {
    const { repo } = discardRepo({ thread: null as never });
    await expect(repo.discard('P', 'nope', 'U')).rejects.toMatchObject({ prefix: 'threads.notFound' });
  });

  it('refuses while threads are disabled', async () => {
    const { repo, jobs } = discardRepo({ threadsEnabled: false });
    await expect(repo.discard('P', 'T', 'U')).rejects.toMatchObject({ prefix: 'threads.disabled' });
    expect(jobs.createJob).not.toHaveBeenCalled();
  });

  it('refuses an archived thread', async () => {
    const { repo, jobs } = discardRepo({ thread: { status: 'ARCHIVED' } });
    await expect(repo.discard('P', 'T', 'U')).rejects.toMatchObject({ prefix: 'threads.archived' });
    expect(jobs.createJob).not.toHaveBeenCalled();
  });

  it('refuses a thread with no runner as nothing to discard', async () => {
    const { repo, jobs } = discardRepo({ thread: { runnerId: null } });
    await expect(repo.discard('P', 'T', 'U')).rejects.toMatchObject({ prefix: 'threads.nothingToDiscard' });
    expect(jobs.createJob).not.toHaveBeenCalled();
  });

  it('refuses an offline pinned runner as runnerOffline', async () => {
    const { repo } = discardRepo({ runner: { lastSeenAt: new Date(Date.now() - 3_600_000), protocolVersion: 4, capabilities: { threadWrite: true } } });
    await expect(repo.discard('P', 'T', 'U')).rejects.toMatchObject({ prefix: 'threads.runnerOffline' });
  });

  it('AC-4: refuses a pinned runner without threadWrite as runnerOutdated', async () => {
    const { repo, jobs } = discardRepo({ runner: { lastSeenAt: seenNow(), protocolVersion: 4, capabilities: {} } });
    await expect(repo.discard('P', 'T', 'U')).rejects.toMatchObject({ prefix: 'threads.runnerOutdated' });
    expect(jobs.createJob).not.toHaveBeenCalled();
  });

  it('refuses a runner on an older protocol as runnerOutdated', async () => {
    const { repo } = discardRepo({ runner: { lastSeenAt: seenNow(), protocolVersion: 3, capabilities: { threadWrite: true } } });
    await expect(repo.discard('P', 'T', 'U')).rejects.toMatchObject({ prefix: 'threads.runnerOutdated' });
  });

  it('refuses while the budget pauses the thread scope, as Publish does', async () => {
    const { repo, jobs } = discardRepo({ budgetPaused: true });
    await expect(repo.discard('P', 'T', 'U')).rejects.toMatchObject({ name: 'BudgetPausedException' });
    expect(jobs.createJob).not.toHaveBeenCalled();
  });

  it('AC-3: refuses with threads.busy while the thread SESSION job is RUNNING', async () => {
    const { repo, jobs } = discardRepo({ active: { id: 'SJ', state: 'RUNNING', command: 'THREAD', runnerId: 'RN', leaseEpoch: 7, action: 'SESSION' } });
    await expect(repo.discard('P', 'T', 'U')).rejects.toMatchObject({ prefix: 'threads.busy' });
    expect(jobs.createJob).not.toHaveBeenCalled();
  });

  it('AC-6: refuses with threads.busy while a PLAN job of the thread is QUEUED', async () => {
    const { repo, jobs } = discardRepo({ active: { id: 'PJ', state: 'QUEUED', command: 'PLAN', runnerId: null, leaseEpoch: 0 } });
    await expect(repo.discard('P', 'T', 'U')).rejects.toMatchObject({ prefix: 'threads.busy' });
    expect(jobs.createJob).not.toHaveBeenCalled();
  });

  it('refuses with threads.busy while a PUBLISH job of the thread is active', async () => {
    const { repo, jobs } = discardRepo({ active: { id: 'UJ', state: 'RUNNING', command: 'THREAD', runnerId: 'RN', leaseEpoch: 1, action: 'PUBLISH' } });
    await expect(repo.discard('P', 'T', 'U')).rejects.toMatchObject({ prefix: 'threads.busy' });
    expect(jobs.createJob).not.toHaveBeenCalled();
  });

  it('applies the refusals in the brief order: nothingToDiscard before busy', async () => {
    const { repo } = discardRepo({ thread: { runnerId: null }, active: { id: 'PJ', state: 'QUEUED', command: 'PLAN', runnerId: null, leaseEpoch: 0 } });
    await expect(repo.discard('P', 'T', 'U')).rejects.toMatchObject({ prefix: 'threads.nothingToDiscard' });
  });
});
