import { TicketWatchersRepository } from './ticket-watchers.repository';

function setup() {
  const ticketWatcher = {
    createMany: jest.fn().mockResolvedValue({ count: 1 }),
    findMany: jest.fn().mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]),
    upsert: jest.fn().mockResolvedValue({}),
    findUnique: jest.fn().mockResolvedValue(null),
    count: jest.fn().mockResolvedValue(2),
  };
  const project = { findUnique: jest.fn().mockResolvedValue({ key: 'PP' }) };
  const ticket = { findFirst: jest.fn().mockResolvedValue({ id: 't1' }) };
  const repo = new TicketWatchersRepository({ client: { ticketWatcher, project, ticket } } as never);
  return { repo, ticketWatcher, project, ticket };
}

describe('TicketWatchersRepository (S4a §1, D502)', () => {
  it('ensure inserts if absent, first reason per user wins, and never updates', async () => {
    const { repo, ticketWatcher } = setup();
    await repo.ensure('t1', [{ userId: 'u1', reason: 'REPORTER' }, { userId: 'u1', reason: 'COMMENTER' }, { userId: 'u2', reason: 'MENTIONED' }]);
    expect(ticketWatcher.createMany).toHaveBeenCalledWith({
      data: [{ ticketId: 't1', userId: 'u1', reason: 'REPORTER' }, { ticketId: 't1', userId: 'u2', reason: 'MENTIONED' }],
      skipDuplicates: true,
    });
    expect(ticketWatcher.upsert).not.toHaveBeenCalled();
  });

  it('ensure is a no-op for no entries', async () => {
    const { repo, ticketWatcher } = setup();
    await repo.ensure('t1', []);
    expect(ticketWatcher.createMany).not.toHaveBeenCalled();
  });

  it('findUnmutedUserIds reads unmuted rows', async () => {
    const { repo, ticketWatcher } = setup();
    await expect(repo.findUnmutedUserIds('t1')).resolves.toEqual(['u1', 'u2']);
    expect(ticketWatcher.findMany).toHaveBeenCalledWith({ where: { ticketId: 't1', muted: false }, select: { userId: true } });
  });

  it('watch un-mutes, unwatch mutes, both insert MANUAL when absent', async () => {
    const { repo, ticketWatcher } = setup();
    await repo.watch('t1', 'u1');
    expect(ticketWatcher.upsert).toHaveBeenLastCalledWith({
      where: { ticketId_userId: { ticketId: 't1', userId: 'u1' } },
      create: { ticketId: 't1', userId: 'u1', reason: 'MANUAL', muted: false },
      update: { muted: false },
    });
    await repo.unwatch('t1', 'u1');
    expect(ticketWatcher.upsert).toHaveBeenLastCalledWith({
      where: { ticketId_userId: { ticketId: 't1', userId: 'u1' } },
      create: { ticketId: 't1', userId: 'u1', reason: 'MANUAL', muted: true },
      update: { muted: true },
    });
  });

  it('state reports the caller\'s watching flag and the unmuted count', async () => {
    const { repo, ticketWatcher } = setup();
    ticketWatcher.findUnique.mockResolvedValueOnce({ muted: true });
    await expect(repo.state('t1', 'u1')).resolves.toEqual({ watching: false, count: 2 });
    ticketWatcher.findUnique.mockResolvedValueOnce({ muted: false });
    await expect(repo.state('t1', 'u1')).resolves.toEqual({ watching: true, count: 2 });
    await expect(repo.state('t1', 'u9')).resolves.toEqual({ watching: false, count: 2 });
    expect(ticketWatcher.count).toHaveBeenCalledWith({ where: { ticketId: 't1', muted: false } });
  });

  it('findTicketIdByRef resolves KEY-N of this project only, case-insensitive, and never a deleted ticket', async () => {
    const { repo, ticket } = setup();
    await expect(repo.findTicketIdByRef('p1', 'pp-7')).resolves.toBe('t1');
    expect(ticket.findFirst).toHaveBeenLastCalledWith({ where: { projectId: 'p1', number: 7, deletedAt: null }, select: { id: true } });
    await expect(repo.findTicketIdByRef('p1', 'OTHER-7')).resolves.toBeNull();
    await repo.findTicketIdByRef('p1', 'ckabc');
    expect(ticket.findFirst).toHaveBeenLastCalledWith({ where: { id: 'ckabc', projectId: 'p1', deletedAt: null }, select: { id: true } });
  });
});
