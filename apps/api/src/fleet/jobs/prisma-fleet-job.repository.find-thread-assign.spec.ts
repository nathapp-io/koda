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
