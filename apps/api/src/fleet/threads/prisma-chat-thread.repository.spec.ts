import { Prisma } from '../../generated/prisma/client';
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
    await expect(repo.command({ kind: 'project', projectId: 'P' }, 'T', 'U', 'THREAD_CLOSE', {})).rejects.toMatchObject({ prefix: 'threads.noSession' });
    expect(jobs.createCommand).not.toHaveBeenCalled();
  });

  it('AC-14: answers threads.noSession for a stop on a live DISCARD job', async () => {
    const { repo, jobs } = commandRepo({ action: 'DISCARD' });
    await expect(repo.command({ kind: 'project', projectId: 'P' }, 'T', 'U', 'THREAD_STOP_TURN', {})).rejects.toMatchObject({ prefix: 'threads.noSession' });
    expect(jobs.createCommand).not.toHaveBeenCalled();
  });

  it('AC-15: an answer on a live PUBLISH job with no pending question answers threads.noQuestion first', async () => {
    const { repo, jobs } = commandRepo({ action: 'PUBLISH' });
    await expect(repo.command({ kind: 'project', projectId: 'P' }, 'T', 'U', 'THREAD_ANSWER', { requestId: 'q1', text: 'yes' })).rejects.toMatchObject({ prefix: 'threads.noQuestion' });
    expect(jobs.createCommand).not.toHaveBeenCalled();
  });

  it('AC-15: C2-D7 covers only stop and end-session, so an answer with a matching question still reaches the job', async () => {
    const { repo, jobs } = commandRepo({ action: 'PUBLISH', pendingQuestion: { requestId: 'q1' } });
    await repo.command({ kind: 'project', projectId: 'P' }, 'T', 'U', 'THREAD_ANSWER', { requestId: 'q1', text: 'yes' });
    expect(jobs.createCommand).toHaveBeenCalledWith(expect.objectContaining({ type: 'THREAD_ANSWER', jobId: 'J' }));
  });

  it('a stop on a live SESSION job still queues the command', async () => {
    const { repo, jobs, notifier } = commandRepo({ action: 'SESSION' });
    await repo.command({ kind: 'project', projectId: 'P' }, 'T', 'U', 'THREAD_STOP_TURN', {});
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
    const thread = await repo.get({ kind: 'project', projectId: 'P' }, 'T');
    expect(thread?.session).toEqual(session);
  });

  it('US-003 AC-12: get() passes a session with projectCodeUnavailableOn through unchanged', async () => {
    const session = {
      jobId: 'J', state: 'live', resumed: false, contextReset: false, reason: null, at: 'A', projectCodeUnavailableOn: 'wk-mac',
    };
    const repo = repoOfThreadRow(threadRow({ kind: 'PROJECT', session }));

    const thread = await repo.get({ kind: 'project', projectId: 'P' }, 'T');

    expect(thread?.session).toEqual(session);
    expect(thread?.session?.projectCodeUnavailableOn).toBe('wk-mac');
  });

  it('US-004 AC12: get() maps a thread with no session to a null session', async () => {
    const repo = repoOfThreadRow(threadRow({ session: null }));

    expect((await repo.get({ kind: 'project', projectId: 'P' }, 'T'))?.session).toBeNull();
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
    const thread = await repo.get({ kind: 'project', projectId: 'P' }, 'T');
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
    expect(await repo.get({ kind: 'project', projectId: 'P' }, 'T')).toMatchObject({
      kind: 'PROJECT', repoId: null, baseRef: null, feature: null, specPath: null,
    });
  });

  it('US-002: get() maps a row with no kind (written before the column) to kind REPO', async () => {
    const withoutKind = threadRow();
    delete withoutKind.kind;
    const repo = repoOfThreadRow(withoutKind);
    expect(await repo.get({ kind: 'project', projectId: 'P' }, 'T')).toMatchObject({ kind: 'REPO', repoId: 'R', feature: 'f' });
  });

  it('US-002: get() maps an unknown stored kind to kind REPO', async () => {
    const repo = repoOfThreadRow(threadRow({ kind: 'FUTURE' }));
    expect((await repo.get({ kind: 'project', projectId: 'P' }, 'T'))?.kind).toBe('REPO');
  });

  it('US-001 AC-8: get() maps a stored WORKSPACE kind to kind WORKSPACE', async () => {
    const repo = repoOfThreadRow(threadRow({ kind: 'WORKSPACE', repoId: null, baseRef: null, feature: null, specPath: null }));
    expect((await repo.get({ kind: 'workspace', userId: 'U' }, 'T'))?.kind).toBe('WORKSPACE');
  });

  it('US-001 AC-9: get() maps the stored projectId onto the record', async () => {
    const repo = repoOfThreadRow(threadRow({ kind: 'WORKSPACE', repoId: null, baseRef: null, feature: null, specPath: null }));
    expect((await repo.get({ kind: 'workspace', userId: 'U' }, 'T'))?.projectId).toBe('P');
  });

  it('US-003 AC13: messages() passes the after-seq filter and limit to the query', async () => {
    const findMany = vi.fn(async () => []);
    const prisma = { client: { chatMessage: { findMany } } } as never;
    const repo = new PrismaChatThreadRepository(prisma, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    await repo.messages('T', 4, 25);
    expect(findMany).toHaveBeenCalledWith({ where: { threadId: 'T', seq: { gt: 4 } }, orderBy: { seq: 'asc' }, take: 25 });
  });
});

/**
 * US-001 AC-8/AC-9 — the WORKSPACE kind survives create(): the stored row's kind and projectId reach the record.
 * The `projectId` column is the thread's project (for a WORKSPACE thread, its home project).
 */
describe('PrismaChatThreadRepository.create on a WORKSPACE row (US-001)', () => {
  const workspaceRow = {
    id: 'T', projectId: 'P', kind: 'WORKSPACE', repoId: null, baseRef: null, feature: null, title: 'x', createdById: 'U',
    runnerId: null, backend: { kind: 'native' }, status: 'ACTIVE', archivedAt: null, skills: [], maxCostUsd: { toString: () => '5' },
    costUsd: { toString: () => '0' }, tokens: null, specPath: null, pendingQuestion: null, session: null,
    writtenPaths: [], publishedSha: null, specPublished: false, lastWrite: null,
    lastActivityAt: new Date(0), createdAt: new Date(0),
  };

  function repoOfCreatedRow(row: Record<string, unknown>): PrismaChatThreadRepository {
    const prisma = { client: { chatThread: { create: vi.fn(async () => row) } } } as never;
    return new PrismaChatThreadRepository(prisma, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  }

  const createWorkspace = (repo: PrismaChatThreadRepository) => repo.create({
    kind: 'WORKSPACE', projectId: 'P', repoId: null, baseRef: null, feature: null, title: 'x', createdById: 'U',
    backend: { kind: 'native' }, skills: [], maxCostUsd: '5',
  });

  it('AC-8: create() returns kind WORKSPACE for a row stored with kind WORKSPACE', async () => {
    const thread = await createWorkspace(repoOfCreatedRow(workspaceRow));
    expect(thread.kind).toBe('WORKSPACE');
  });

  it('AC-9: create() returns the record projectId equal to the stored row projectId', async () => {
    const thread = await createWorkspace(repoOfCreatedRow(workspaceRow));
    expect(thread.projectId).toBe('P');
  });
});

/**
 * The stored instructions of a SESSION turn (S5b US-003 AC-10/AC-11 at the repository level, without a database): a
 * send whose repository context was resolved beforehand stores the brief block, and one without it stores exactly
 * today's instructions.
 */
describe('PrismaChatThreadRepository SESSION turn instructions (S5b US-003)', () => {
  const threadRow = (over: Record<string, unknown> = {}) => ({
    id: 'T', projectId: 'P', kind: 'REPO', repoId: 'R', baseRef: 'trunk', feature: 'f', title: 'x', createdById: 'U', runnerId: null,
    backend: { kind: 'native' }, status: 'ACTIVE', archivedAt: null, skills: [], maxCostUsd: new Prisma.Decimal(5),
    costUsd: new Prisma.Decimal(0), tokens: null, specPath: '.nax/features/f/spec.md', pendingQuestion: null, session: null,
    writtenPaths: [], publishedSha: null, specPublished: false, lastWrite: null,
    lastActivityAt: new Date(0), createdAt: new Date(0), ...over,
  });

  const messageRow = { id: 'M', threadId: 'T', seq: 1, jobId: null, turnId: null, role: 'user', authorUserId: 'U', clientMessageId: 'c1', content: 'hi', toolSummary: null, status: 'pending', errorReason: null, usage: null, costUsd: null, costSource: null, streamRound: null, streamRoundStart: null, createdAt: new Date(0) };

  /** A repository whose Prisma fake answers the send path: one thread row, no active job and a fresh message sequence. */
  function sendRepo(row: Record<string, unknown>) {
    const turnCreate = vi.fn(async (_args: unknown) => ({}));
    const projectFindUnique = vi.fn(async (_args: unknown) => ({ slug: 'sandbox', brief: 'Seeded brief' }));
    const repoFindUnique = vi.fn(async (_args: unknown) => ({ owner: 'acme', name: 'koda' }));
    const anchorFindFirst = vi.fn(async (_args: unknown) => ({ id: 'A', defaultBranch: 'trunk' }));
    const prisma = {
      client: {
        chatThread: { findFirst: vi.fn(async () => row), update: vi.fn(async () => row) },
        chatMessage: { findUnique: vi.fn(async () => null), findFirst: vi.fn(async () => null), create: vi.fn(async () => messageRow), update: vi.fn(async () => messageRow) },
        fleetJob: { findFirst: vi.fn(async () => null) },
        fleetThreadTurn: { findFirst: vi.fn(async () => null), create: turnCreate },
        fleetRepo: { findUnique: repoFindUnique, findFirst: anchorFindFirst },
        project: { findUnique: projectFindUnique },
        $queryRaw: vi.fn(async () => [{ nextSeq: 1 }]),
      },
    };
    const jobs = { createJob: vi.fn(async () => ({ id: 'J', repoId: 'R', ref: 'trunk' })), appendEvent: vi.fn(async () => ({})) };
    const txManager = { run: vi.fn(async (fn: () => Promise<unknown>) => fn()) };
    const repo = new PrismaChatThreadRepository(
      prisma as never, jobs as never, txManager as never, { record: vi.fn(async () => ({})) } as never, { placeJob: vi.fn(async () => undefined) } as never,
      { notify: vi.fn() } as never, { snapshot: vi.fn(async () => ({ match: () => null })) } as never, { threadsEnabled: true } as never,
    );
    return { repo, turnCreate, projectFindUnique, repoFindUnique, anchorFindFirst, jobs };
  }

  const instructionsOf = (turnCreate: { mock: { calls: unknown[][] } }): string => {
    const args = turnCreate.mock.calls.at(-1)?.[0] as { data: { instructions: string } };
    return args.data.instructions;
  };

  it('WORKSPACE SESSION uses the anchor without reading any project brief or repository context', async () => {
    const { repo, turnCreate, projectFindUnique, repoFindUnique, jobs } = sendRepo(threadRow({ kind: 'WORKSPACE', repoId: null, baseRef: null, feature: null, specPath: null }));
    await repo.sendMessage({ scope: { kind: 'workspace', userId: 'U' }, threadId: 'T', userId: 'U', text: 'hi', clientMessageId: 'c1', repoContext: 'must be ignored' });
    expect(jobs.createJob).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'P', repoId: 'A', ref: 'trunk', command: 'THREAD', feature: 'thread-T' }));
    expect(projectFindUnique).not.toHaveBeenCalled();
    expect(repoFindUnique).not.toHaveBeenCalled();
    expect(instructionsOf(turnCreate)).toMatch(/^You are a brainstorming partner in a koda workspace thread\./);
    expect(instructionsOf(turnCreate)).not.toContain('must be ignored');
  });

  it('US-003 AC-10: a PROJECT SESSION turn stores the project brief and the anchor repository section after the role line', async () => {
    const { repo, turnCreate, anchorFindFirst, projectFindUnique } = sendRepo(threadRow({ kind: 'PROJECT', repoId: null, baseRef: null, feature: null, specPath: null }));

    await repo.sendMessage({ scope: { kind: 'project', projectId: 'P' }, threadId: 'T', userId: 'U', text: 'hi', clientMessageId: 'c1', repoContext: 'Repository context: unavailable (no installation)' });

    expect(anchorFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { projectId: 'P' } }));
    expect(projectFindUnique).toHaveBeenCalledWith({ where: { id: 'P' }, select: { slug: true, brief: true } });
    expect(instructionsOf(turnCreate).split('\n').slice(1, 4))
      .toEqual(['Project brief:', 'Seeded brief', 'Repository context: unavailable (no installation)']);
    expect(turnCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'SESSION' }) });
  });

  it('US-003 AC-11: a REPO SESSION turn stores the project brief as lines two and three', async () => {
    const { repo, turnCreate, projectFindUnique, repoFindUnique } = sendRepo(threadRow());

    await repo.sendMessage({ scope: { kind: 'project', projectId: 'P' }, threadId: 'T', userId: 'U', text: 'hi', clientMessageId: 'c1', repoContext: 'Repository context: unavailable (no context file)' });

    expect(repoFindUnique).toHaveBeenCalledWith({ where: { id: 'R' }, select: { owner: true, name: true } });
    expect(projectFindUnique).toHaveBeenCalledWith({ where: { id: 'P' }, select: { brief: true } });
    expect(instructionsOf(turnCreate).split('\n').slice(1, 3)).toEqual(['Project brief:', 'Seeded brief']);
  });

  it('US-003: a SESSION send without a repository context stores exactly today\'s instructions and no project brief read', async () => {
    const { repo, turnCreate, projectFindUnique } = sendRepo(threadRow());

    await repo.sendMessage({ scope: { kind: 'project', projectId: 'P' }, threadId: 'T', userId: 'U', text: 'hi', clientMessageId: 'c1' });

    expect(projectFindUnique).not.toHaveBeenCalled();
    expect(instructionsOf(turnCreate).split('\n')).not.toContain('Project brief:');
  });

  it('US-003: a null project brief renders (none) under the header', async () => {
    const { repo, turnCreate, projectFindUnique } = sendRepo(threadRow());
    projectFindUnique.mockResolvedValueOnce({ slug: 'sandbox', brief: null } as never);

    await repo.sendMessage({ scope: { kind: 'project', projectId: 'P' }, threadId: 'T', userId: 'U', text: 'hi', clientMessageId: 'c1', repoContext: 'Repository context: unavailable (no context file)' });

    expect(instructionsOf(turnCreate).split('\n').slice(1, 4))
      .toEqual(['Project brief:', '(none)', 'Repository context: unavailable (no context file)']);
  });
});
