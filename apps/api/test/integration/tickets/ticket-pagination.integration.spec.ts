/**
 * Slice 3 — ticket list paging and filters against real Postgres.
 * Run: cd apps/api && bun run test:db:up && KODA_DB_TESTS=1 bunx jest test/integration/tickets/ticket-pagination
 */
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { PrismaTicketsRepository } from '../../../src/tickets/prisma-tickets.repository';
import { resetDb } from '../../helpers/reset-db';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('ticket list pagination (PG)', () => {
  let prisma: PrismaService<PrismaClient>;
  let repo: PrismaTicketsRepository;
  let projectId: string;

  beforeAll(async () => {
    await resetDb();
    prisma = new PrismaService({ client: PrismaClient, clientOptions: { datasources: { db: { url: DATABASE_URL } } } });
    await prisma.onModuleInit();
    repo = new PrismaTicketsRepository(prisma);

    const project = await prisma.client.project.create({ data: { name: 'Paging', slug: 'paging', key: 'PG' } });
    projectId = project.id;

    // Ticket.assignedToUserId has an FK to User — seed the assignee.
    await prisma.client.user.create({ data: { id: 'user-a', email: 'assignee@example.com', passwordHash: 'hash' } });

    // 7 live tickets (#1-#7): odd numbers IN_PROGRESS, even CREATED; #3 assigned; plus one soft-deleted (#8).
    for (let n = 1; n <= 8; n++) {
      await prisma.client.ticket.create({
        data: {
          projectId,
          number: n,
          type: 'BUG',
          title: `t${n}`,
          status: n % 2 === 1 ? 'IN_PROGRESS' : 'CREATED',
          priority: 'MEDIUM',
          assignedToUserId: n === 3 ? 'user-a' : null,
          deletedAt: n === 8 ? new Date() : null,
        },
      });
    }
  });

  afterAll(async () => {
    await prisma.client.$disconnect();
  });

  it('pages in ticket-number order with correct total and flags', async () => {
    const p1 = await repo.findTicketPage({ projectId }, { current: 1, size: 3 });
    const p3 = await repo.findTicketPage({ projectId }, { current: 3, size: 3 });

    expect(p1.total).toBe(7);
    expect(p1.records.map((t) => t.number)).toEqual([1, 2, 3]);
    expect(p1.hasNext).toBe(true);
    expect(p1.hasPrev).toBe(false);
    expect(p3.records.map((t) => t.number)).toEqual([7]);
    expect(p3.hasNext).toBe(false);
  });

  it('counts only rows matching the filter', async () => {
    const page = await repo.findTicketPage({ projectId, status: 'IN_PROGRESS' }, { current: 1, size: 2 });
    expect(page.total).toBe(4); // #1 #3 #5 #7
    expect(page.records.map((t) => t.number)).toEqual([1, 3]);
    expect(page.hasNext).toBe(true);
  });

  it('unassigned excludes assigned tickets; assignedTo selects them', async () => {
    const unassigned = await repo.findTicketPage({ projectId, unassigned: true }, { current: 1, size: 20 });
    const mine = await repo.findTicketPage({ projectId, assignedToUserId: 'user-a' }, { current: 1, size: 20 });
    expect(unassigned.total).toBe(6);
    expect(mine.records.map((t) => t.number)).toEqual([3]);
  });

  it('a page past the end is empty, not an error', async () => {
    const page = await repo.findTicketPage({ projectId }, { current: 999, size: 3 });
    expect(page.records).toEqual([]);
    expect(page.total).toBe(7);
    expect(page.hasNext).toBe(false);
    expect(page.hasPrev).toBe(true);
  });

  it('filters by agent assignee', async () => {
    const agent = await prisma.client.agent.create({ data: { name: 'Bot', slug: 'paging-bot', apiKeyHash: 'paging-bot-hash' } });
    await prisma.client.ticket.create({
      data: { projectId, number: 9, type: 'TASK', title: 't9', status: 'CREATED', priority: 'LOW', assignedToAgentId: agent.id },
    });

    const page = await repo.findTicketPage({ projectId, assignedToAgentId: agent.id }, { current: 1, size: 20 });

    expect(page.records.map((t) => t.number)).toEqual([9]);
  });
});
