import { PrismaHomeRepository } from './prisma-home.repository';

describe('PrismaHomeRepository.findRecentActivity labels', () => {
  it('AC-1: labels ticket events with actor and ticket names', async () => {
    const { repository, calls, events } = fixture();
    const result = await repository.findRecentActivity(['p1'], 25);
    expect(result.ticketEvents.find((event) => event.id === 'te1')).toMatchObject({
      actorName: 'Alice', ticketRef: 'WEB-12', ticketTitle: 'Fix login',
    });
    expect(calls.user).toHaveBeenCalledTimes(1);
    expect(calls.ticket).toHaveBeenCalledTimes(1);
    expect(events.ticket).toHaveBeenCalledTimes(1);
  });

  it('AC-2: labels agent events and keeps their ticket labels null', async () => {
    const { repository } = fixture();
    const result = await repository.findRecentActivity(['p1'], 25);
    expect(result.agentEvents[0]).toMatchObject({ actorName: 'codex-bot', ticketRef: null, ticketTitle: null });
  });

  it('AC-3: normalizes decision agent ids and returns null for an unknown actor', async () => {
    const { repository } = fixture();
    const result = await repository.findRecentActivity(['p1'], 25);
    expect(result.decisionEvents[0]).toMatchObject({ actorId: 'gone', actorName: null, ticketId: null });
  });

  it('AC-4: returns null ticket labels when the referenced ticket is missing', async () => {
    const { repository } = fixture();
    const result = await repository.findRecentActivity(['p1'], 25);
    expect(result.ticketEvents.find((event) => event.id === 'te2')).toMatchObject({ ticketRef: null, ticketTitle: null });
  });

  it('AC-5: batches every actor id into one principal read', async () => {
    const { repository, calls } = fixture();
    await repository.findRecentActivity(['p1'], 25);
    expect(calls.user).toHaveBeenCalledTimes(1);
    expect(calls.user).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: expect.arrayContaining(['u1', 'a1', 'gone']) } } }));
    expect((calls.user.mock.calls[0][0] as { where: { id: { in: string[] } } }).where.id.in).toHaveLength(3);
  });

  it('AC-6: batches non-null ticket ids into one label read', async () => {
    const { repository, calls } = fixture();
    await repository.findRecentActivity(['p1'], 25);
    expect(calls.ticket).toHaveBeenCalledTimes(1);
    expect(calls.ticket).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: expect.arrayContaining(['t1', 'gone-t']) } } }));
    expect((calls.ticket.mock.calls[0][0] as { where: { id: { in: string[] } } }).where.id.in).toHaveLength(2);
  });
});

function fixture() {
  const ticketEvents = [
    { id: 'te1', projectId: 'p1', action: 'CREATED', actorId: 'u1', ticketId: 't1', createdAt: new Date('2026-01-01') },
    { id: 'te2', projectId: 'p1', action: 'UPDATED', actorId: 'u1', ticketId: 'gone-t', createdAt: new Date('2026-01-02') },
  ];
  const agentEvents = [{ id: 'ae1', projectId: 'p1', action: 'RUN', actorId: 'a1', createdAt: new Date('2026-01-03') }];
  const decisionEvents = [{ id: 'de1', projectId: 'p1', action: 'decided', agentId: 'gone', createdAt: new Date('2026-01-04') }];
  const events = {
    ticket: vi.fn().mockResolvedValue(ticketEvents),
    agent: vi.fn().mockResolvedValue(agentEvents),
    decision: vi.fn().mockResolvedValue(decisionEvents),
  };
  const calls = {
    user: vi.fn().mockResolvedValue([{ id: 'u1', name: 'Alice', email: 'alice@example.com' }]),
    agent: vi.fn().mockResolvedValue([{ id: 'a1', name: 'codex-bot' }]),
    ticket: vi.fn().mockResolvedValue([{ id: 't1', number: 12, title: 'Fix login', project: { key: 'WEB' } }]),
  };
  const client = {
    ticketEvent: { findMany: events.ticket },
    agentEvent: { findMany: events.agent },
    decisionEvent: { findMany: events.decision },
    user: { findMany: calls.user },
    agent: { findMany: calls.agent },
    ticket: { findMany: calls.ticket },
  };
  const repository = new PrismaHomeRepository({ client } as never);
  return { repository, calls, events };
}
