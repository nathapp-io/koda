import { PrismaTicketsRepository } from './prisma-tickets.repository';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../generated/prisma/client';

describe('PrismaTicketsRepository — updateTicketStatusIf (M3 hardening)', () => {
  it('keys the conditional update on id + status + deletedAt: null so soft-deleted tickets cannot be transitioned', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const findUnique = vi.fn().mockResolvedValue(null);
    const repo = new PrismaTicketsRepository({
      client: { ticket: { updateMany, findUnique } },
    } as unknown as PrismaService<PrismaClient>);

    await repo.updateTicketStatusIf('ticket-123', 'CREATED', 'VERIFIED');

    expect(updateMany).toHaveBeenCalledTimes(1);
    const whereArg = updateMany.mock.calls[0][0].where;
    expect(whereArg).toEqual({ id: 'ticket-123', status: 'CREATED', deletedAt: null });
  });
});

describe('PrismaTicketsRepository assignee mapping (M26)', () => {
  const row = (over: Record<string, unknown>) => ({
    id: 't1', projectId: 'p1', number: 1, type: 'BUG', title: 'x', description: null, status: 'CREATED', priority: 'LOW',
    assignedToUserId: null, assignedToAgentId: null, createdByUserId: null, createdByAgentId: null,
    gitRefVersion: null, gitRefFile: null, gitRefLine: null, createdAt: new Date(), updatedAt: new Date(), deletedAt: null,
    labels: [], links: [], assignedToUser: null, assignedToAgent: null, ...over,
  });
  const repoWith = (found: unknown) => {
    const findUnique = vi.fn().mockResolvedValue(found);
    const prisma = { client: { ticket: { findUnique } } };
    return { repo: new PrismaTicketsRepository(prisma as never), findUnique };
  };

  it('selects only id/name/email of the assigned user and falls back to email for a null name', async () => {
    const { repo, findUnique } = repoWith(row({ assignedToUserId: 'u1', assignedToUser: { id: 'u1', name: null, email: 'ada@x' } }));
    const t = await repo.findTicketById('t1');
    expect(t?.assignee).toEqual({ kind: 'user', id: 'u1', name: 'ada@x' });
    expect(findUnique.mock.calls[0][0].include.assignedToUser).toEqual({ select: { id: true, name: true, email: true } });
  });

  it('maps an assigned agent by name', async () => {
    const { repo } = repoWith(row({ assignedToAgentId: 'a1', assignedToAgent: { id: 'a1', name: 'bot' } }));
    expect((await repo.findTicketById('t1'))?.assignee).toEqual({ kind: 'agent', id: 'a1', name: 'bot' });
  });

  it('maps no assignee to null', async () => {
    const { repo } = repoWith(row({}));
    expect((await repo.findTicketById('t1'))?.assignee).toBeNull();
  });
});

describe('PrismaTicketsRepository — hasFleetOwnership (#231)', () => {
  const repoWith = (fleetPrCount: number, activeJobCount: number) => {
    const ticketLinkCount = vi.fn().mockResolvedValue(fleetPrCount);
    const fleetJobTicketCount = vi.fn().mockResolvedValue(activeJobCount);
    const prisma = {
      client: { ticketLink: { count: ticketLinkCount }, fleetJobTicket: { count: fleetJobTicketCount } },
    };
    return { repo: new PrismaTicketsRepository(prisma as never), ticketLinkCount, fleetJobTicketCount };
  };

  it('is true when a fleet-sourced pr link exists', async () => {
    const { repo, ticketLinkCount, fleetJobTicketCount } = repoWith(1, 0);
    await expect(repo.hasFleetOwnership('t1')).resolves.toBe(true);
    expect(ticketLinkCount).toHaveBeenCalledWith({
      where: { ticketId: 't1', linkType: 'pr', source: 'fleet' },
    });
    expect(fleetJobTicketCount).toHaveBeenCalledWith({
      where: { ticketId: 't1', job: { state: { in: ['QUEUED', 'ASSIGNED', 'RUNNING', 'UPLOADING'] } } },
    });
  });

  it('is true when a non-terminal fleet job is linked', async () => {
    const { repo } = repoWith(0, 1);
    await expect(repo.hasFleetOwnership('t1')).resolves.toBe(true);
  });

  it('is false when neither a fleet pr link nor an active job exists', async () => {
    const { repo } = repoWith(0, 0);
    await expect(repo.hasFleetOwnership('t1')).resolves.toBe(false);
  });
});

describe('PrismaTicketsRepository — findTicketRefs (S5b US-005)', () => {
  const repoWith = (rows: unknown[]) => {
    const findMany = vi.fn().mockResolvedValue(rows);
    const prisma = { client: { ticket: { findMany } } };
    return { repo: new PrismaTicketsRepository(prisma as never), findMany };
  };

  it('scopes the read to the project and to the named, non-deleted ids, in one query', async () => {
    const { repo, findMany } = repoWith([
      { id: 't1', number: 3, project: { key: 'WEB' } },
      { id: 't2', number: 12, project: { key: 'WEB' } },
    ]);

    const refs = await repo.findTicketRefs('p1', ['t1', 't2', 't-of-another-project']);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: { projectId: 'p1', id: { in: ['t1', 't2', 't-of-another-project'] }, deletedAt: null },
      select: { id: true, number: true, project: { select: { key: true } } },
    });
    expect(refs).toEqual([
      { id: 't1', ref: 'WEB-3' },
      { id: 't2', ref: 'WEB-12' },
    ]);
  });

  it('answers no rows for an empty id list without touching the database', async () => {
    const { repo, findMany } = repoWith([]);

    await expect(repo.findTicketRefs('p1', [])).resolves.toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});
