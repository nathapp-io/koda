import { PrismaChatThreadRepository } from './prisma-chat-thread.repository';

/** A ChatMessage row as Prisma returns it, including the fold-internal round columns. */
const row = {
  id: 'm2', threadId: 'T', seq: 2, jobId: 'J', turnId: 't1', role: 'assistant', authorUserId: null,
  clientMessageId: null, content: 'Hello', toolSummary: null, status: 'streaming', errorReason: null,
  usage: null, costUsd: null, costSource: null, streamRound: 1, streamRoundStart: 0,
  createdAt: new Date('2026-10-14T00:00:00.000Z'),
};

/**
 * A `command` fake: the thread row, the current THREAD job (state RUNNING, action `action`), and no close command.
 * `txManager.run` calls through; `createCommand` records what it queues.
 */
function commandRepo(opts: { action: 'SESSION' | 'PUBLISH' | 'DISCARD'; pendingQuestion?: unknown }) {
  const threadRow = {
    id: 'T', projectId: 'P', createdById: 'U', pendingQuestion: opts.pendingQuestion ?? null, status: 'ACTIVE',
  };
  const job = { id: 'J', state: 'RUNNING', runnerId: 'R', leaseEpoch: 4, command: 'THREAD' };
  const prisma = {
    client: {
      chatThread: { findFirst: vi.fn(async () => threadRow) },
      fleetJob: { findFirst: vi.fn(async () => ({ ...job, threadTurn: { action: opts.action } })) },
      fleetThreadTurn: { findUnique: vi.fn(async () => ({ action: opts.action })) },
      fleetCommand: { findFirst: vi.fn(async () => null) },
      $queryRaw: vi.fn(async () => []),
    },
  };
  const jobs = { lockById: vi.fn(async () => undefined), createCommand: vi.fn(async () => ({})) };
  const txManager = { run: vi.fn(async (fn: () => Promise<unknown>) => fn()) };
  const notifier = { notify: vi.fn() };
  const repo = new PrismaChatThreadRepository(
    prisma as never, jobs as never, txManager as never, {} as never, {} as never, notifier as never, {} as never,
    { threadsEnabled: true } as never,
  );
  return { repo, jobs, notifier };
}

describe('PrismaChatThreadRepository.command while a PUBLISH or DISCARD job is active (US-004)', () => {
  it('AC-14: answers threads.noSession for an end-session on a live PUBLISH job', async () => {
    const { repo, jobs } = commandRepo({ action: 'PUBLISH' });
    await expect(repo.command('P', 'T', 'U', 'THREAD_CLOSE', {})).rejects.toMatchObject({ prefix: 'threads.noSession' });
    expect(jobs.createCommand).not.toHaveBeenCalled();
  });

  it('AC-14: answers threads.noSession for a stop on a live DISCARD job', async () => {
    const { repo, jobs } = commandRepo({ action: 'DISCARD' });
    await expect(repo.command('P', 'T', 'U', 'THREAD_STOP_TURN', {})).rejects.toMatchObject({ prefix: 'threads.noSession' });
    expect(jobs.createCommand).not.toHaveBeenCalled();
  });

  it('AC-15: an answer on a live PUBLISH job with no pending question answers threads.noQuestion first', async () => {
    const { repo, jobs } = commandRepo({ action: 'PUBLISH' });
    await expect(repo.command('P', 'T', 'U', 'THREAD_ANSWER', { requestId: 'q1', text: 'yes' })).rejects.toMatchObject({ prefix: 'threads.noQuestion' });
    expect(jobs.createCommand).not.toHaveBeenCalled();
  });

  it('AC-15: C2-D7 covers only stop and end-session, so an answer with a matching question still reaches the job', async () => {
    const { repo, jobs } = commandRepo({ action: 'PUBLISH', pendingQuestion: { requestId: 'q1' } });
    await repo.command('P', 'T', 'U', 'THREAD_ANSWER', { requestId: 'q1', text: 'yes' });
    expect(jobs.createCommand).toHaveBeenCalledWith(expect.objectContaining({ type: 'THREAD_ANSWER', jobId: 'J' }));
  });

  it('a stop on a live SESSION job still queues the command', async () => {
    const { repo, jobs, notifier } = commandRepo({ action: 'SESSION' });
    await repo.command('P', 'T', 'U', 'THREAD_STOP_TURN', {});
    expect(jobs.createCommand).toHaveBeenCalledWith(expect.objectContaining({ type: 'THREAD_STOP_TURN', jobId: 'J', leaseEpoch: 4 }));
    expect(notifier.notify).toHaveBeenCalledWith('R');
  });
});

describe('PrismaChatThreadRepository message mapping (US-003)', () => {
  function repoWith(findMany: (args: unknown) => Promise<unknown[]>): PrismaChatThreadRepository {
    const prisma = { client: { chatMessage: { findMany: vi.fn(findMany) } } } as never;
    return new PrismaChatThreadRepository(
      prisma, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    );
  }

  /** The repository's thread mapping, driven through get() with a stub Prisma row. */
  function repoOfThreadRow(threadRow: Record<string, unknown>): PrismaChatThreadRepository {
    const prisma = {
      client: {
        chatThread: { findFirst: vi.fn(async () => threadRow) },
        fleetJob: { findFirst: vi.fn(async () => null) },
      },
    } as never;
    return new PrismaChatThreadRepository(prisma, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  }

  const threadRow = (over: Record<string, unknown> = {}) => ({
    id: 'T', projectId: 'P', kind: 'REPO', repoId: 'R', baseRef: 'trunk', feature: 'f', title: 'x', createdById: 'U', runnerId: null,
    backend: { kind: 'native' }, status: 'ACTIVE', archivedAt: null, skills: [], maxCostUsd: { toString: () => '5' },
    costUsd: { toString: () => '0' }, tokens: null, specPath: 's', pendingQuestion: null, session: null,
    lastActivityAt: new Date(0), createdAt: new Date(0), ...over,
  });

  it('US-003 AC13: messages() returns rows without threadId, streamRound or streamRoundStart', async () => {
    const repo = repoWith(async () => [row]);
    const [message] = await repo.messages('T', 0, 100);
    expect(message).toMatchObject({ id: 'm2', seq: 2, content: 'Hello', status: 'streaming', turnId: 't1' });
    expect(Object.hasOwn(message as object, 'threadId')).toBe(false);
    expect(Object.hasOwn(message as object, 'streamRound')).toBe(false);
    expect(Object.hasOwn(message as object, 'streamRoundStart')).toBe(false);
  });

  it('US-003 AC13: messages() keeps costUsd as a string and null when unpriced', async () => {
    const repo = repoWith(async () => [{ ...row, costUsd: { toString: () => '0.0123' } }, row]);
    const [priced, unpriced] = await repo.messages('T', 0, 100);
    expect(priced?.costUsd).toBe('0.0123');
    expect(unpriced?.costUsd).toBeNull();
  });

  it('US-004 AC15: get() maps the stored session JSON onto the thread record', async () => {
    const session = { jobId: 'J', state: 'closed', resumed: false, contextReset: false, reason: 'idle', at: 'A' };
    const threadRow = {
      id: 'T', projectId: 'P', repoId: 'R', baseRef: 'trunk', feature: 'f', title: 'x', createdById: 'U', runnerId: null,
      backend: { kind: 'native' }, status: 'ACTIVE', archivedAt: null, skills: [], maxCostUsd: { toString: () => '5' },
      costUsd: { toString: () => '0' }, tokens: null, specPath: 's', pendingQuestion: null, session,
      lastActivityAt: new Date(0), createdAt: new Date(0),
    };
    const prisma = {
      client: {
        chatThread: { findFirst: vi.fn(async () => threadRow) },
        fleetJob: { findFirst: vi.fn(async () => null) },
      },
    } as never;
    const repo = new PrismaChatThreadRepository(prisma, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    const thread = await repo.get('P', 'T');
    expect(thread?.session).toEqual(session);
  });

  it('US-004 AC12: get() maps a thread with no session to a null session', async () => {
    const threadRow = {
      id: 'T', projectId: 'P', repoId: 'R', baseRef: 'trunk', feature: 'f', title: 'x', createdById: 'U', runnerId: null,
      backend: { kind: 'native' }, status: 'ACTIVE', archivedAt: null, skills: [], maxCostUsd: { toString: () => '5' },
      costUsd: { toString: () => '0' }, tokens: null, specPath: 's', pendingQuestion: null, session: null,
      lastActivityAt: new Date(0), createdAt: new Date(0),
    };
    const prisma = {
      client: {
        chatThread: { findFirst: vi.fn(async () => threadRow) },
        fleetJob: { findFirst: vi.fn(async () => null) },
      },
    } as never;
    const repo = new PrismaChatThreadRepository(prisma, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    expect((await repo.get('P', 'T'))?.session).toBeNull();
  });

  it('US-001 AC-14: get() maps writtenPaths, publishedSha, specPublished and lastWrite unchanged', async () => {
    const lastWrite = { kind: 'published', jobId: 'j1', at: '2026-10-15T00:00:00.000Z', sha: 'a'.repeat(40), paths: ['docs/a.md'], ignored: [] };
    const threadRow = {
      id: 'T', projectId: 'P', repoId: 'R', baseRef: 'trunk', feature: 'f', title: 'x', createdById: 'U', runnerId: null,
      backend: { kind: 'native' }, status: 'ACTIVE', archivedAt: null, skills: [], maxCostUsd: { toString: () => '5' },
      costUsd: { toString: () => '0' }, tokens: null, specPath: 's', pendingQuestion: null, session: null,
      writtenPaths: ['docs/a.md'], publishedSha: 'a'.repeat(40), specPublished: true, lastWrite,
      lastActivityAt: new Date(0), createdAt: new Date(0),
    };
    const prisma = {
      client: {
        chatThread: { findFirst: vi.fn(async () => threadRow) },
        fleetJob: { findFirst: vi.fn(async () => null) },
      },
    } as never;
    const repo = new PrismaChatThreadRepository(prisma, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    const thread = await repo.get('P', 'T');
    expect(thread).toMatchObject({ writtenPaths: ['docs/a.md'], publishedSha: 'a'.repeat(40), specPublished: true, lastWrite });
  });

  it('US-001 AC-1: create() reads back the write-path defaults', async () => {
    const createdRow = {
      id: 'T', projectId: 'P', repoId: 'R', baseRef: 'trunk', feature: 'f', title: 'x', createdById: 'U', runnerId: null,
      backend: { kind: 'native' }, status: 'ACTIVE', archivedAt: null, skills: [], maxCostUsd: { toString: () => '5' },
      costUsd: { toString: () => '0' }, tokens: null, specPath: 's', pendingQuestion: null, session: null,
      writtenPaths: [], publishedSha: null, specPublished: false, lastWrite: null,
      lastActivityAt: new Date(0), createdAt: new Date(0),
    };
    const prisma = { client: { chatThread: { create: vi.fn(async () => createdRow) } } } as never;
    const repo = new PrismaChatThreadRepository(prisma, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    const thread = await repo.create({ kind: 'REPO', projectId: 'P', repoId: 'R', baseRef: 'trunk', feature: 'f', title: 'x', createdById: 'U', backend: { kind: 'native' }, skills: [], maxCostUsd: '5' });
    expect(thread).toMatchObject({ writtenPaths: [], publishedSha: null, specPublished: false, lastWrite: null });
  });

  it('US-003: create() writes specPath from the feature for a REPO thread and null for a PROJECT thread', async () => {
    const createdRow = {
      id: 'T', projectId: 'P', repoId: null, baseRef: null, feature: null, title: 'x', createdById: 'U', runnerId: null,
      backend: { kind: 'native' }, status: 'ACTIVE', archivedAt: null, skills: [], maxCostUsd: { toString: () => '5' },
      costUsd: { toString: () => '0' }, tokens: null, specPath: null, pendingQuestion: null, session: null,
      writtenPaths: [], publishedSha: null, specPublished: false, lastWrite: null,
      lastActivityAt: new Date(0), createdAt: new Date(0),
    };
    const create = vi.fn(async () => createdRow);
    const prisma = { client: { chatThread: { create } } } as never;
    const repo = new PrismaChatThreadRepository(prisma, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);

    await repo.create({ kind: 'PROJECT', projectId: 'P', repoId: null, baseRef: null, feature: null, title: 'x', createdById: 'U', backend: { kind: 'native' }, skills: [], maxCostUsd: '5' });
    expect(create).toHaveBeenLastCalledWith({ data: expect.objectContaining({ kind: 'PROJECT', repoId: null, baseRef: null, feature: null, specPath: null }) });

    await repo.create({ kind: 'REPO', projectId: 'P', repoId: 'R', baseRef: 'trunk', feature: 'add-auth', title: 'x', createdById: 'U', backend: { kind: 'native' }, skills: [], maxCostUsd: '5' });
    expect(create).toHaveBeenLastCalledWith({ data: expect.objectContaining({ kind: 'REPO', repoId: 'R', feature: 'add-auth', specPath: '.nax/features/add-auth/spec.md' }) });
  });

  it('US-002: get() maps a PROJECT row to kind PROJECT with null repo fields', async () => {
    const repo = repoOfThreadRow(threadRow({ kind: 'PROJECT', repoId: null, baseRef: null, feature: null, specPath: null }));
    expect(await repo.get('P', 'T')).toMatchObject({
      kind: 'PROJECT', repoId: null, baseRef: null, feature: null, specPath: null,
    });
  });

  it('US-002: get() maps a row with no kind (written before the column) to kind REPO', async () => {
    const withoutKind = threadRow();
    delete withoutKind.kind;
    const repo = repoOfThreadRow(withoutKind);
    expect(await repo.get('P', 'T')).toMatchObject({ kind: 'REPO', repoId: 'R', feature: 'f' });
  });

  it('US-002: get() maps an unknown stored kind to kind REPO', async () => {
    const repo = repoOfThreadRow(threadRow({ kind: 'WORKSPACE' }));
    expect((await repo.get('P', 'T'))?.kind).toBe('REPO');
  });

  it('US-003 AC13: messages() passes the after-seq filter and limit to the query', async () => {
    const findMany = vi.fn(async () => []);
    const prisma = { client: { chatMessage: { findMany } } } as never;
    const repo = new PrismaChatThreadRepository(prisma, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    await repo.messages('T', 4, 25);
    expect(findMany).toHaveBeenCalledWith({ where: { threadId: 'T', seq: { gt: 4 } }, orderBy: { seq: 'asc' }, take: 25 });
  });
});
