import { PrismaFleetJobRepository } from './prisma-fleet-job.repository';

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

  it('treats an unknown kind as REPO', async () => {
    const { repo } = stub({ kind: 'WORKSPACE', feature: 'auth' });
    expect(await repo.findThreadAssign('j1')).toMatchObject({ kind: 'REPO' });
  });
});
