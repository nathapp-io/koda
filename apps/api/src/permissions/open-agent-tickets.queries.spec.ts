/**
 * Permissions P1 US-002 — `countOpenAgentTickets`, the open-ticket read behind the agent-binding
 * removal guard.
 *
 * The counting and ref-shape cases moved here from
 * `agents/prisma-agent.repository.project-roster-writes.spec.ts`: `PrismaAgentRepository` delegates
 * to this query until US-003 deletes the delegate, so the assertion follows the code it pins.
 */
import type { PrismaClient } from '../generated/prisma/client';
import { KodaError } from '../common/koda-error';
import { MAX_OPEN_TICKET_REFS, countOpenAgentTickets } from './open-agent-tickets.queries';

interface FakeClient {
  db: PrismaClient;
  ticket: { count: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  project: { findUnique: ReturnType<typeof vi.fn> };
}

/** A Prisma client double holding only the two delegates the query reads. */
const clientDouble = (): FakeClient => {
  const ticket = { count: vi.fn(), findMany: vi.fn() };
  const project = { findUnique: vi.fn() };
  return { db: { ticket, project } as unknown as PrismaClient, ticket, project };
};

describe('countOpenAgentTickets (US-002)', () => {
  it('counts the open tickets and refs the oldest ones as <key>-<number>', async () => {
    const { db, ticket, project } = clientDouble();
    ticket.count.mockResolvedValue(12);
    ticket.findMany.mockResolvedValue([{ number: 3 }, { number: 4 }]);
    project.findUnique.mockResolvedValue({ key: 'ALP' });

    const result = await countOpenAgentTickets(db, 'agent-1', 'proj-1');

    expect(result).toEqual({ count: 12, refs: ['ALP-3', 'ALP-4'] });
    const where = ticket.count.mock.calls[0][0].where;
    expect(where).toEqual({
      projectId: 'proj-1',
      assignedToAgentId: 'agent-1',
      status: { notIn: ['CLOSED', 'REJECTED'] },
      deletedAt: null,
    });
    expect(ticket.findMany.mock.calls[0][0]).toMatchObject({
      where,
      select: { number: true },
      take: MAX_OPEN_TICKET_REFS,
    });
    expect(ticket.findMany.mock.calls[0][0].orderBy).toEqual([{ createdAt: 'asc' }, { number: 'asc' }]);
  });

  it('exports the 10-ref bound the roster read also uses', () => {
    expect(MAX_OPEN_TICKET_REFS).toBe(10);
  });

  it('answers no refs and reads no project when no ticket is open', async () => {
    const { db, ticket, project } = clientDouble();
    ticket.count.mockResolvedValue(0);
    ticket.findMany.mockResolvedValue([]);

    await expect(countOpenAgentTickets(db, 'agent-1', 'proj-1')).resolves.toEqual({ count: 0, refs: [] });
    expect(project.findUnique).not.toHaveBeenCalled();
  });

  it('AC-11: rejects with a PROJECT_NOT_FOUND KodaError when the project row is gone while refs are built', async () => {
    const { db, ticket, project } = clientDouble();
    ticket.count.mockResolvedValue(1);
    ticket.findMany.mockResolvedValue([{ number: 7 }]);
    project.findUnique.mockResolvedValue(null);

    const error = await countOpenAgentTickets(db, 'agent-1', 'proj-1').catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(KodaError);
    expect((error as KodaError).code).toBe('PROJECT_NOT_FOUND');
  });
});
