import { Prisma } from '../../generated/prisma/client';
import { MAX_PENDING_ACTIONS, type PendingActionStatus } from '../assistant/actions/pending-action.domain';
import { DELIVERABLE_STATUSES, DELIVERY_HEADER, deliveryText } from '../assistant/actions/outcome-delivery';
import { outcomeNote } from '../assistant/actions/outcome-note';
import { THREAD_LIMITS } from '../common/thread-jobs';
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
 * S5b US-004 — the thread detail's pending actions (2a-D12): the read is a unit test with a fake Prisma client,
 * because the entry shape and the slug join are the contract, and the DB-mode spec asserts the same facts through
 * the detail routes.
 */
describe('PrismaChatThreadRepository.pendingActions (S5b US-004)', () => {
  const createdAt = new Date('2026-10-23T09:00:00.000Z');
  const expiresAt = new Date('2026-10-24T09:00:00.000Z');

  const actionRow = (over: Record<string, unknown> = {}) => ({
    id: 'A1', projectId: 'P-web', approvalId: 'AP1', tool: 'koda_add_comment',
    preview: 'Add a comment to KODA-1 "Fix login":\n\nhello', expiresAt, createdAt, ...over,
  });

  function repoWith(rows: Array<Record<string, unknown>>, projects: Array<{ id: string; slug: string }>) {
    const pendingFindMany = vi.fn(async () => rows);
    const projectFindMany = vi.fn(async () => projects);
    const prisma = { client: { pendingAction: { findMany: pendingFindMany }, project: { findMany: projectFindMany } } } as never;
    const repo = new PrismaChatThreadRepository(prisma, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    return { repo, pendingFindMany, projectFindMany };
  }

  it('AC-1: reads only the thread PENDING actions, oldest first, capped at MAX_PENDING_ACTIONS', async () => {
    const { repo, pendingFindMany } = repoWith([actionRow()], []);

    await repo.pendingActions({ kind: 'project', projectId: 'P-web' }, 'T');

    expect(pendingFindMany).toHaveBeenCalledWith({
      where: { threadId: 'T', status: 'PENDING', thread: { projectId: 'P-web', kind: { not: 'WORKSPACE' } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: MAX_PENDING_ACTIONS,
      select: { id: true, projectId: true, approvalId: true, tool: true, preview: true, expiresAt: true, createdAt: true },
    });
  });

  /**
   * M1: the thread fence lives in the query, not in a prior `get()`, so a caller that uses this repository method on
   * its own can never read a preview outside its scope.
   */
  it('M1: carries the workspace fence in the query, so only the owner\'s WORKSPACE thread matches', async () => {
    const { repo, pendingFindMany } = repoWith([actionRow()], [{ id: 'P-web', slug: 'web' }]);

    await repo.pendingActions({ kind: 'workspace', userId: 'U1' }, 'T');

    expect(pendingFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { threadId: 'T', status: 'PENDING', thread: { createdById: 'U1', kind: 'WORKSPACE' } },
    }));
  });

  it('M1: a thread outside the caller\'s scope answers no previews, even with no prior get()', async () => {
    const pendingFindMany = vi.fn(async ({ where }: { where: { thread: { projectId?: string } } }) =>
      where.thread.projectId === 'P-other' ? [actionRow()] : []);
    const prisma = { client: { pendingAction: { findMany: pendingFindMany }, project: { findMany: vi.fn(async () => []) } } } as never;
    const repo = new PrismaChatThreadRepository(prisma, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);

    expect(await repo.pendingActions({ kind: 'project', projectId: 'P-mine' }, 'T')).toEqual([]);
  });

  it('AC-2/AC-3: answers exactly the six entry fields with the slug of the project the action acts in', async () => {
    const { repo } = repoWith([actionRow()], [{ id: 'P-web', slug: 'web' }]);

    const [entry] = await repo.pendingActions({ kind: 'project', projectId: 'P-web' }, 'T');

    expect(entry).toEqual({
      id: 'A1', approvalId: 'AP1', tool: 'koda_add_comment',
      preview: 'Add a comment to KODA-1 "Fix login":\n\nhello', projectSlug: 'web', expiresAt, createdAt,
    });
    expect(Object.keys(entry as object).sort()).toEqual(['approvalId', 'createdAt', 'expiresAt', 'id', 'preview', 'projectSlug', 'tool']);
  });

  it('AC-4: each entry carries its own action project slug, read as one join', async () => {
    const { repo, projectFindMany } = repoWith(
      [actionRow({ id: 'A1', projectId: 'P-ops' }), actionRow({ id: 'A2', projectId: 'P-web' })],
      [{ id: 'P-ops', slug: 'ops' }, { id: 'P-web', slug: 'web' }],
    );

    const entries = await repo.pendingActions({ kind: 'project', projectId: 'P-ops' }, 'T');

    expect(entries.map((entry) => entry.projectSlug)).toEqual(['ops', 'web']);
    expect(projectFindMany).toHaveBeenCalledWith({ where: { id: { in: ['P-ops', 'P-web'] } }, select: { id: true, slug: true } });
  });

  it('AC-5: a thread with no pending action answers an empty array and reads no project', async () => {
    const { repo, projectFindMany } = repoWith([], [{ id: 'P-web', slug: 'web' }]);

    expect(await repo.pendingActions({ kind: 'project', projectId: 'P-web' }, 'T')).toEqual([]);
    expect(projectFindMany).not.toHaveBeenCalled();
  });

  it('maps a missing approval link to a null approvalId', async () => {
    const { repo } = repoWith([actionRow({ approvalId: null })], [{ id: 'P-web', slug: 'web' }]);
    expect((await repo.pendingActions({ kind: 'project', projectId: 'P-web' }, 'T'))[0]?.approvalId).toBeNull();
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
        pendingAction: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
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

/**
 * 2aw-D3 — the outcome hand-off inside `sendMessage`, without a database: the thread's undelivered terminal actions
 * are selected in age order, marked delivered on the new message and their notes are handed to the runner path in the
 * `THREAD_INPUT` text of a live send. A new-turn send marks them the same way (its assign text is US-001's, pinned
 * over PG); a duplicate `clientMessageId` and a refused send deliver nothing.
 *
 * `pendingStore()` is a small in-memory `pendingAction` double of the two operations the hand-off uses: `findMany`
 * applies the status/`deliveredAt` filter, the age order and `take`, and `updateMany` writes the markers onto the rows
 * it holds — so the selection, the marking and the resulting text are all observable without PG.
 */
describe('PrismaChatThreadRepository.sendMessage outcome hand-off (2aw US-002)', () => {
  interface StoredAction {
    id: string; threadId: string; tool: string; status: string; result: string | null;
    deliveredAt: Date | null; deliveredMessageId: string | null; createdAt: Date;
  }

  const action = (over: Partial<StoredAction> & { id: string }): StoredAction => ({
    threadId: 'T', tool: 'koda_add_comment', status: 'EXECUTED', result: 'done',
    deliveredAt: null, deliveredMessageId: null, createdAt: new Date('2026-01-01T00:00:00.000Z'), ...over,
  });

  /** The note the delivered text carries, built with the real US-001 helper. */
  const noteOf = (a: StoredAction): string =>
    outcomeNote({ id: a.id, tool: a.tool, status: a.status as PendingActionStatus, result: a.result });

  /** The `pendingAction` delegate over `rows`: the repository's `findMany` and `updateMany`, nothing else. */
  function pendingStore(rows: readonly StoredAction[]) {
    const all = [...rows];
    const findMany = vi.fn(async (args: {
      where: { threadId: string; status: { in: string[] }; deliveredAt: null };
      orderBy: readonly unknown[]; take: number;
    }) => all
      .filter((row) => row.threadId === args.where.threadId && args.where.status.in.includes(row.status) && row.deliveredAt === null)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
      .slice(0, args.take)
      .map((row) => ({ id: row.id, tool: row.tool, status: row.status, result: row.result })));
    const updateMany = vi.fn(async (args: {
      where: { id: { in: string[] } }; data: { deliveredAt: Date; deliveredMessageId: string };
    }) => {
      let count = 0;
      for (const row of all) {
        if (args.where.id.in.includes(row.id)) {
          row.deliveredAt = args.data.deliveredAt;
          row.deliveredMessageId = args.data.deliveredMessageId;
          count += 1;
        }
      }
      return { count };
    });
    return { all, findMany, updateMany };
  }

  const threadRow = (over: Record<string, unknown> = {}) => ({
    id: 'T', projectId: 'P', kind: 'REPO', repoId: 'R', baseRef: 'trunk', feature: 'f', title: 'x', createdById: 'U',
    runnerId: 'R', backend: { kind: 'native' }, status: 'ACTIVE', archivedAt: null, skills: [], maxCostUsd: new Prisma.Decimal(5),
    costUsd: new Prisma.Decimal(0), tokens: null, specPath: '.nax/features/f/spec.md', pendingQuestion: null, session: null,
    writtenPaths: [], publishedSha: null, specPublished: false, lastWrite: null,
    lastActivityAt: new Date(0), createdAt: new Date(0), ...over,
  });

  /**
   * A repository driving one send. `live` queues a `THREAD_INPUT` on a RUNNING SESSION job instead of creating a
   * turn; `inFlight` makes the refusal gate see a pending message. The message fake keeps a clientMessageId set, so a
   * repeated id answers the duplicate the way the unique index would.
   */
  function deliveryRepo(opts: { actions?: readonly StoredAction[]; live?: boolean; thread?: Record<string, unknown>; inFlight?: boolean } = {}) {
    const store = pendingStore(opts.actions ?? []);
    const thread = threadRow(opts.thread);
    const job = { id: 'J', state: 'RUNNING', runnerId: 'R', leaseEpoch: 4, command: 'THREAD', threadTurn: { action: 'SESSION' } };
    const created = new Map<string, Record<string, unknown>>();
    const messageCreate = vi.fn(async (args: { data: { content: string; clientMessageId: string } }) => {
      const createdRow = {
        id: 'M', threadId: 'T', seq: 2, jobId: null, turnId: null, role: 'user', authorUserId: 'U',
        clientMessageId: args.data.clientMessageId, content: args.data.content, toolSummary: null, status: 'pending',
        errorReason: null, usage: null, costUsd: null, costSource: null, streamRound: null, streamRoundStart: null, createdAt: new Date(0),
      };
      created.set(args.data.clientMessageId, createdRow);
      return createdRow;
    });
    const commandCreate = vi.fn(async (_args: unknown) => ({}));
    const jobCreate = vi.fn(async (_args: unknown) => ({ id: 'J2', repoId: 'R', ref: 'trunk' }));
    const prisma = {
      client: {
        chatThread: { findFirst: vi.fn(async () => thread), update: vi.fn(async () => ({})) },
        chatMessage: {
          findUnique: vi.fn(async (args: { where: { threadId_clientMessageId: { clientMessageId: string } } }) =>
            created.get(args.where.threadId_clientMessageId.clientMessageId) ?? null),
          findFirst: vi.fn(async () => (opts.inFlight ? { id: 'PENDING' } : null)),
          create: messageCreate, update: vi.fn(async () => ({})),
        },
        fleetJob: { findFirst: vi.fn(async () => (opts.live ? job : null)) },
        fleetThreadTurn: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({})) },
        fleetRepo: { findUnique: vi.fn(async () => ({ owner: 'acme', name: 'koda' })), findFirst: vi.fn(async () => ({ id: 'A', defaultBranch: 'trunk' })) },
        project: { findUnique: vi.fn(async () => ({ slug: 'sandbox', brief: null })) },
        runner: { findUnique: vi.fn(async () => ({ lastSeenAt: new Date(), protocolVersion: 5 })) },
        fleetCommand: { findFirst: vi.fn(async () => null) },
        pendingAction: { findMany: store.findMany, updateMany: store.updateMany },
        $queryRaw: vi.fn(async () => [{ nextSeq: 2 }]),
      },
    };
    const jobs = {
      createJob: jobCreate, appendEvent: vi.fn(async () => ({})), createCommand: commandCreate,
      lockById: vi.fn(async () => undefined),
    };
    const repo = new PrismaChatThreadRepository(
      prisma as never, jobs as never, { run: vi.fn(async (fn: () => Promise<unknown>) => fn()) } as never,
      { record: vi.fn(async () => ({})) } as never, { placeJob: vi.fn(async () => undefined) } as never,
      { notify: vi.fn() } as never, { snapshot: vi.fn(async () => ({ match: () => null })) } as never, { threadsEnabled: true, runnerOfflineSec: 90 } as never,
    );
    return { repo, store, jobs, messageCreate, commandCreate, jobCreate };
  }

  const send = (repo: PrismaChatThreadRepository, text: string, clientMessageId = 'c1') =>
    repo.sendMessage({ scope: { kind: 'project', projectId: 'P' }, threadId: 'T', userId: 'U', text, clientMessageId });

  const payloadTexts = (commandCreate: { mock: { calls: unknown[][] } }): string[] =>
    commandCreate.mock.calls.map((call) => (call[0] as { payload: { text: string } }).payload.text);

  it('AC-1: a live send queues a THREAD_INPUT whose text is the note block above the user text', async () => {
    const executed = action({ id: 'A1', status: 'EXECUTED', result: 'done' });
    const { repo, commandCreate } = deliveryRepo({ actions: [executed], live: true });

    await send(repo, 'hello');

    const expected = `${DELIVERY_HEADER}\n${noteOf(executed)}\n\nhello`;
    expect(commandCreate).toHaveBeenCalledWith({
      runnerId: 'R', jobId: 'J', type: 'THREAD_INPUT', leaseEpoch: 4, payload: { messageId: 'M', text: expected },
    });
    // The expected text is exactly what US-001's delivery helper answers for that one note.
    expect(deliveryText([noteOf(executed)], 'hello', THREAD_LIMITS.messageMaxBytes)).toEqual({ text: expected, delivered: 1 });
  });

  it('AC-2/AC-3: the send marks the action delivered at now, naming the new message', async () => {
    const executed = action({ id: 'A1' });
    const { repo, store } = deliveryRepo({ actions: [executed], live: true });

    await send(repo, 'hello');

    expect(store.updateMany).toHaveBeenCalledTimes(1);
    expect(store.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['A1'] } }, data: { deliveredAt: expect.any(Date), deliveredMessageId: 'M' },
    });
    expect(executed.deliveredAt).not.toBeNull();
    expect(executed.deliveredMessageId).toBe('M');
  });

  it('AC-4: the stored user message keeps the plain text', async () => {
    const { repo, messageCreate } = deliveryRepo({ actions: [action({ id: 'A1' })], live: true });

    const result = await send(repo, 'hello');

    expect(messageCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ content: 'hello' }) });
    expect(result.message.content).toBe('hello');
  });

  it('AC-5: a second send after the first turn ended delivers nothing again', async () => {
    const executed = action({ id: 'A1' });
    const { repo, commandCreate, store } = deliveryRepo({ actions: [executed], live: true });

    await send(repo, 'hello');
    // The first message reached a terminal status, so the second send is not a turn in flight.
    await send(repo, 'again', 'c2');

    expect(payloadTexts(commandCreate)).toEqual([`${DELIVERY_HEADER}\n${noteOf(executed)}\n\nhello`, 'again']);
    expect(store.updateMany).toHaveBeenCalledTimes(1);
  });

  it('AC-6: a PENDING action stays undelivered and is never even read as deliverable', async () => {
    const pending = action({ id: 'A1', status: 'PENDING', result: null });
    // A terminal neighbour proves the filter picks notes rather than nothing at all.
    const executed = action({ id: 'A2', createdAt: new Date('2026-01-01T00:01:00.000Z') });
    const { repo, store, commandCreate } = deliveryRepo({ actions: [pending, executed], live: true });

    await send(repo, 'hello');

    expect(store.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { threadId: 'T', status: { in: [...DELIVERABLE_STATUSES] }, deliveredAt: null },
    }));
    expect(pending.deliveredAt).toBeNull();
    expect(pending.deliveredMessageId).toBeNull();
    expect(executed.deliveredMessageId).toBe('M');
    expect(store.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['A2'] } }, data: expect.anything() });
    expect(payloadTexts(commandCreate)).toEqual([`${DELIVERY_HEADER}\n${noteOf(executed)}\n\nhello`]);
  });

  it('AC-7: an APPROVED action stays undelivered', async () => {
    const approved = action({ id: 'A1', status: 'APPROVED', result: null });
    const executed = action({ id: 'A2', createdAt: new Date('2026-01-01T00:01:00.000Z') });
    const { repo, store, commandCreate } = deliveryRepo({ actions: [approved, executed], live: true });

    await send(repo, 'hello');

    expect(approved.deliveredAt).toBeNull();
    expect(approved.deliveredMessageId).toBeNull();
    expect(executed.deliveredMessageId).toBe('M');
    expect(store.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['A2'] } }, data: expect.anything() });
    expect(payloadTexts(commandCreate)).toEqual([`${DELIVERY_HEADER}\n${noteOf(executed)}\n\nhello`]);
  });

  it('AC-8: a terminal action of another thread stays undelivered', async () => {
    const elsewhere = action({ id: 'A9', threadId: 'T2' });
    const { repo, store } = deliveryRepo({ actions: [action({ id: 'A1' }), elsewhere], live: true });

    await send(repo, 'hello');

    expect(store.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ threadId: 'T' }) }));
    expect(elsewhere.deliveredAt).toBeNull();
    expect(store.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['A1'] } }, data: expect.anything() });
  });

  it('AC-9/AC-10: the 20 oldest notes go in age order and the newest of 21 stays undelivered', async () => {
    const many = Array.from({ length: 21 }, (_unused, i) => action({
      id: `A${String(i).padStart(2, '0')}`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
    }));
    const { repo, store } = deliveryRepo({ actions: many, live: true });

    await send(repo, 'hello');

    expect(store.all.filter((row) => row.deliveredAt !== null)).toHaveLength(20);
    // `A20` has the latest createdAt, so it is the one that did not fit the cap.
    expect(store.all.filter((row) => row.deliveredAt === null).map((row) => row.id)).toEqual(['A20']);
    expect(store.findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 20,
    }));
  });

  it('AC-11: a note that does not fit the byte budget stays undelivered', async () => {
    const first = action({ id: 'A1', createdAt: new Date('2026-01-01T00:00:00.000Z'), result: 'ok' });
    const second = action({ id: 'A2', createdAt: new Date('2026-01-01T00:01:00.000Z'), result: 'ok' });
    const { repo, commandCreate } = deliveryRepo({ actions: [first, second], live: true });
    const notes = [noteOf(first), noteOf(second)];
    const oneNote = `${DELIVERY_HEADER}\n${notes[0]}\n\n`;
    // The user text is sized with the delivery helper: the whole text fills the budget with one note only.
    const text = 'x'.repeat(THREAD_LIMITS.messageMaxBytes - Buffer.byteLength(oneNote, 'utf8'));

    expect(deliveryText(notes, text, THREAD_LIMITS.messageMaxBytes)).toEqual({ text: oneNote + text, delivered: 1 });
    await send(repo, text);

    expect(first.deliveredAt).not.toBeNull();
    expect(second.deliveredAt).toBeNull();
    expect(second.deliveredMessageId).toBeNull();
    expect(payloadTexts(commandCreate)).toEqual([oneNote + text]);
  });

  it('AC-12: a duplicate clientMessageId delivers nothing, an action created between the sends included', async () => {
    const { repo, store, commandCreate } = deliveryRepo({ actions: [action({ id: 'A1' })], live: true });

    const first = await send(repo, 'hello', 'c1');
    const later = action({ id: 'A2', createdAt: new Date('2026-01-02T00:00:00.000Z') });
    store.all.push(later);
    const second = await send(repo, 'hello', 'c1');

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(later.deliveredAt).toBeNull();
    expect(later.deliveredMessageId).toBeNull();
    expect(commandCreate).toHaveBeenCalledTimes(1);
  });

  it('AC-13/AC-14: a new-turn send marks the action on the new message and creates the turn', async () => {
    const rejected = action({ id: 'A1', status: 'REJECTED', result: null });
    const { repo, jobCreate, commandCreate } = deliveryRepo({ actions: [rejected], live: false, thread: { runnerId: null } });

    const result = await send(repo, 'hi');

    expect(result).toMatchObject({ jobId: 'J2', deduplicated: false });
    expect(jobCreate).toHaveBeenCalledTimes(1);
    expect(commandCreate).not.toHaveBeenCalled();
    expect(rejected.deliveredAt).not.toBeNull();
    expect(rejected.deliveredMessageId).toBe('M');
  });

  it('AC-15/AC-16: a refused send delivers nothing at all', async () => {
    const executed = action({ id: 'A1' });
    const { repo, store, messageCreate, commandCreate } = deliveryRepo({ actions: [executed], live: true, inFlight: true });

    await expect(send(repo, 'hello')).rejects.toMatchObject({ prefix: 'threads.turnRunning' });

    expect(messageCreate).not.toHaveBeenCalled();
    expect(store.findMany).not.toHaveBeenCalled();
    expect(store.updateMany).not.toHaveBeenCalled();
    expect(commandCreate).not.toHaveBeenCalled();
    expect(executed.deliveredAt).toBeNull();
    expect(executed.deliveredMessageId).toBeNull();
  });
});
