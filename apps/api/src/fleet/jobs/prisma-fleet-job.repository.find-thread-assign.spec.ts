import { PrismaFleetJobRepository } from './prisma-fleet-job.repository';
import { DELIVERY_HEADER } from '../assistant/actions/outcome-delivery';
import { requestOutcomeNote } from '../assistant/requests/request-outcome-note';
import type { ApprovalRequestStatus } from '../../../approvals/domain/approval.domain';

/**
 * US-001 AC-13: findThreadAssign returns the thread's title on the ASSIGN's thread block.
 * A Prisma-shaped stub stands in for the database; the select on ChatThread must ask for title.
 */
describe('PrismaFleetJobRepository.findThreadAssign title (US-001 AC-13)', () => {
  it('returns title "Add auth" from ChatThread.title', async () => {
    const fleetThreadTurn = {
      findUnique: vi.fn(async () => ({
        jobId: 'j1', threadId: 't1', action: 'SESSION', initialMessageId: null, instructions: 'go',
        backend: { kind: 'native', model: 'm1' }, skills: [], resume: false,
      })),
    };
    const chatThread = {
      findUnique: vi.fn(async (args: { select: Record<string, boolean> }) => {
        const row = { id: 't1', feature: 'auth', title: 'Add auth' };
        return Object.fromEntries(Object.keys(args.select).map((k) => [k, row[k as keyof typeof row]]));
      }),
    };
    const prisma = { client: { fleetThreadTurn, chatThread } };
    const repo = new PrismaFleetJobRepository(prisma as never);

    const assign = await repo.findThreadAssign('j1');

    expect(chatThread.findUnique).toHaveBeenCalledWith(expect.objectContaining({ select: expect.objectContaining({ title: true }) }));
    expect(assign).toEqual(expect.objectContaining({ threadId: 't1', feature: 'auth', title: 'Add auth' }));
  });
});

/**
 * US-005 AC-13: findThreadAssign normalizes the thread's kind for the ASSIGN's `kind` (1a-R1): the row's PROJECT
 * kind wins, anything else (absent, unknown) is REPO. A PROJECT row has no feature, so the job's own
 * `thread-<threadId>` name is sent instead.
 */
describe('PrismaFleetJobRepository.findThreadAssign kind (US-005 AC-13)', () => {
  const stub = (row: { kind?: string; feature?: string | null }) => {
    const fleetThreadTurn = {
      findUnique: vi.fn(async () => ({
        jobId: 'j1', threadId: 't1', action: 'SESSION', initialMessageId: null, instructions: 'go',
        backend: { kind: 'native' }, skills: [], resume: false,
      })),
    };
    const chatThread = {
      findUnique: vi.fn(async (args: { select: Record<string, boolean> }) =>
        Object.fromEntries(Object.keys(args.select).map((k) => [k, (row as Record<string, unknown>)[k]]))),
    };
    const repo = new PrismaFleetJobRepository({ client: { fleetThreadTurn, chatThread } } as never);
    return { repo, chatThread };
  };

  it('AC-13: a row with no kind returns kind REPO and the row feature', async () => {
    const { repo, chatThread } = stub({ kind: undefined, feature: 'auth' });
    expect(await repo.findThreadAssign('j1')).toMatchObject({ kind: 'REPO', feature: 'auth' });
    expect(chatThread.findUnique).toHaveBeenCalledWith(expect.objectContaining({ select: expect.objectContaining({ kind: true }) }));
  });

  it('returns kind PROJECT and the job feature for a PROJECT row with no feature of its own', async () => {
    const { repo } = stub({ kind: 'PROJECT', feature: null });
    expect(await repo.findThreadAssign('j1')).toMatchObject({ kind: 'PROJECT', feature: 'thread-t1' });
  });

  it('workspace AC-1 preserves WORKSPACE and fallback feature', async () => {
    const { repo } = stub({ kind: 'WORKSPACE', feature: null });
    expect(await repo.findThreadAssign('j1')).toMatchObject({ kind: 'WORKSPACE', feature: 'thread-t1' });
  });

  it('treats an unknown kind as REPO', async () => {
    const { repo } = stub({ kind: 'FUTURE', feature: 'auth' });
    expect(await repo.findThreadAssign('j1')).toMatchObject({ kind: 'REPO' });
  });
});

/**
 * 2aw US-001 AC-7..AC-10, AC-12 at the unit level: the initial message's text is rebuilt from the actions
 * `sendMessage` delivered on it, in `createdAt` then `id` order, and nothing is read when the turn has no initial
 * message. The PG round-trip lives in test/integration/fleet/assistant-action-delivery.integration.spec.ts.
 */
describe('PrismaFleetJobRepository.findThreadAssign delivery text (2aw US-001)', () => {
  const noteRow = (over: Partial<{ requestId: string; tool: string; status: ApprovalRequestStatus; result: unknown }> = {}) => ({
    requestId: over.requestId ?? 'a1',
    tool: over.tool ?? 'koda_add_comment',
    request: { status: over.status ?? 'rejected', result: over.result ?? null },
  });

  const stub = (opts: { initialMessageId: string | null; delivered?: ReturnType<typeof noteRow>[]; content?: string }) => {
    const fleetThreadTurn = {
      findUnique: vi.fn(async () => ({
        jobId: 'j1', threadId: 't1', action: 'SESSION', initialMessageId: opts.initialMessageId, instructions: 'go',
        backend: { kind: 'native', model: 'm1' }, skills: [], resume: false,
      })),
    };
    const chatThread = {
      findUnique: vi.fn(async (args: { select: Record<string, boolean> }) => {
        const row: Record<string, unknown> = { id: 't1', feature: 'auth', title: 'Add auth', kind: 'REPO' };
        return Object.fromEntries(Object.keys(args.select).map((k) => [k, row[k]]));
      }),
    };
    const chatMessage = {
      findUnique: vi.fn(async (args: { select: Record<string, boolean> }) => {
        const row: Record<string, unknown> = { id: opts.initialMessageId, content: opts.content ?? 'go' };
        return Object.fromEntries(Object.keys(args.select).map((k) => [k, row[k]]));
      }),
    };
    const assistantActionRequest = { findMany: vi.fn(async () => opts.delivered ?? []) };
    const repo = new PrismaFleetJobRepository({ client: { fleetThreadTurn, chatThread, chatMessage, assistantActionRequest } } as never);
    return { repo, assistantActionRequest };
  };

  it('delivers the notes of the actions delivered on the initial message, in order, above the content', async () => {
    const first = noteRow({ requestId: 'a1', status: 'executed', result: { text: 'did it' } });
    const second = noteRow({ requestId: 'a2', status: 'rejected' });
    const { repo } = stub({ initialMessageId: 'm1', delivered: [first, second] });

    const assign = await repo.findThreadAssign('j1');

    expect(assign?.initialMessage).toEqual({
      messageId: 'm1',
      text: `${DELIVERY_HEADER}\n${requestOutcomeNote({ requestId: first.requestId, tool: first.tool, status: first.request.status, result: first.request.result })}\n${requestOutcomeNote({ requestId: second.requestId, tool: second.tool, status: second.request.status, result: second.request.result })}\n\ngo`,
    });
  });

  it('reads the actions delivered on that message, oldest first, and only the deliverable statuses', async () => {
    const { repo, assistantActionRequest } = stub({ initialMessageId: 'm1', delivered: [] });

    await repo.findThreadAssign('j1');

    expect(assistantActionRequest.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { deliveredMessageId: 'm1', request: { status: { in: ['executed', 'failed', 'rejected', 'expired', 'cancelled'] } } },
      orderBy: [{ createdAt: 'asc' }, { requestId: 'asc' }],
    }));
  });

  it('answers the message content unchanged when no action was delivered on it', async () => {
    const { repo } = stub({ initialMessageId: 'm1', delivered: [], content: 'do the thing' });

    expect((await repo.findThreadAssign('j1'))?.initialMessage).toEqual({ messageId: 'm1', text: 'do the thing' });
  });

  it('AC-12: answers the same text on every assign, writing nothing', async () => {
    const { repo, assistantActionRequest } = stub({ initialMessageId: 'm1', delivered: [noteRow()] });

    const first = await repo.findThreadAssign('j1');
    const second = await repo.findThreadAssign('j1');

    expect(second?.initialMessage).toEqual(first?.initialMessage);
    expect(assistantActionRequest.findMany).toHaveBeenCalledTimes(2);
    expect(assistantActionRequest).not.toHaveProperty('update');
  });

  it('AC-10: reads no actions and answers initialMessage null when the turn has no initial message', async () => {
    // The client stub has no `pendingAction` delegate at all: any read would throw.
    const fleetThreadTurn = {
      findUnique: vi.fn(async () => ({
        jobId: 'j1', threadId: 't1', action: 'SESSION', initialMessageId: null, instructions: 'go',
        backend: { kind: 'native', model: 'm1' }, skills: [], resume: false,
      })),
    };
    const chatThread = {
      findUnique: vi.fn(async (args: { select: Record<string, boolean> }) => {
        const row: Record<string, unknown> = { feature: 'auth', title: 'Add auth', kind: 'REPO' };
        return Object.fromEntries(Object.keys(args.select).map((k) => [k, row[k]]));
      }),
    };
    const repo = new PrismaFleetJobRepository({ client: { fleetThreadTurn, chatThread } } as never);

    await expect(repo.findThreadAssign('j1')).resolves.toMatchObject({ initialMessage: null });
  });
});
