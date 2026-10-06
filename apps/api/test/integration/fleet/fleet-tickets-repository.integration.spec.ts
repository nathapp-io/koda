/**
 * Fleet C9 slice 1a — PrismaFleetTicketsRepository (PG), spec §1-§3.2.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-tickets-repository.integration.spec.ts
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { PrismaFleetTicketsRepository } from '../../../src/fleet/tickets/prisma-fleet-tickets.repository';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('fleet tickets repository (PG)', () => {
  const prisma = new PrismaClient();
  const repo = new PrismaFleetTicketsRepository({ client: prisma } as never);
  let projectId: string;
  let repoId: string;
  let userId: string;

  const newJob = (feature: string, extra: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) =>
    prisma.fleetJob.create({
      data: {
        projectId, repoId, ref: 'main', command: 'RUN', feature, profiles: [],
        maxCostUsd: new Prisma.Decimal('1'), selectorLabels: [], requestedById: userId, ...extra,
      },
    });
  const newTicket = (number: number, extra: Partial<Prisma.TicketUncheckedCreateInput> = {}) =>
    prisma.ticket.create({ data: { projectId, number, type: 'TASK', title: `t${number}`, ...extra } });

  beforeAll(async () => {
    await resetDb();
    const user = await prisma.user.create({ data: { email: 'u@koda.test', passwordHash: 'x', role: 'ADMIN' } });
    const project = await prisma.project.create({ data: { name: 'Web', slug: 'web', key: 'WEB' } });
    const repoRow = await prisma.fleetRepo.create({
      data: { projectId: project.id, provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', createdById: user.id },
    });
    userId = user.id;
    projectId = project.id;
    repoId = repoRow.id;
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('finds the project key and slug, and tickets by number including deleted ones', async () => {
    expect(await repo.findProject(projectId)).toEqual({ key: 'WEB', slug: 'web' });
    const live = await newTicket(1);
    await newTicket(2, { deletedAt: new Date() });
    const rows = await repo.findTicketsByNumbers(projectId, [1, 2, 99]);
    expect(rows.map((r) => [r.number, r.deletedAt === null])).toEqual(expect.arrayContaining([[1, true], [2, false]]));
    expect(await repo.findTicketByRef(projectId, 'WEB', 'web-1')).toEqual({ id: live.id });
    expect(await repo.findTicketByRef(projectId, 'WEB', live.id)).toEqual({ id: live.id });
    expect(await repo.findTicketByRef(projectId, 'WEB', 'OPS-1')).toBeNull();
    expect(await repo.findTicketByRef(projectId, 'WEB', 'WEB-2')).toBeNull();
  });

  it('links tickets, lists them by number and hides a ticket deleted later', async () => {
    const job = await newJob('link');
    const [a, b] = [await newTicket(11), await newTicket(10)];
    await repo.linkTickets(job.id, [a.id, b.id]);
    expect((await repo.findTicketsForJob(job.id)).map((t) => t.ref)).toEqual(['WEB-10', 'WEB-11']);
    await prisma.ticket.update({ where: { id: a.id }, data: { deletedAt: new Date() } });
    expect((await repo.findTicketsForJob(job.id)).map((t) => t.ref)).toEqual(['WEB-10']);
  });

  it('claims a notification once per epoch and again for a later epoch', async () => {
    const job = await newJob('claim');
    const t = await newTicket(20);
    await repo.linkTickets(job.id, [t.id]);
    expect(await repo.claimNotified(job.id, t.id, 1)).toBe(true);
    expect(await repo.claimNotified(job.id, t.id, 1)).toBe(false);
    expect(await repo.claimNotified(job.id, t.id, 2)).toBe(true);
    expect(await repo.claimNotified(job.id, 'missing', 3)).toBe(false);
  });

  it('reads the job for effects with the project slug', async () => {
    const job = await newJob('effects', { state: 'ESCALATED', leaseEpoch: 2, escalationReason: 'review blocked' });
    expect(await repo.findJobForEffects(job.id)).toEqual(expect.objectContaining({
      id: job.id, projectSlug: 'web', command: 'RUN', state: 'ESCALATED', leaseEpoch: 2, escalationReason: 'review blocked', requestedById: userId,
    }));
    expect(await repo.findJobForEffects('missing')).toBeNull();
  });

  it('writes a system comment with no author', async () => {
    const t = await newTicket(30);
    const { id } = await repo.createSystemComment(t.id, 'hello');
    expect(await prisma.comment.findUniqueOrThrow({ where: { id } })).toEqual(
      expect.objectContaining({ body: 'hello', type: 'GENERAL', authorUserId: null, authorAgentId: null }),
    );
  });

  it('lists a ticket\'s jobs newest first, capped', async () => {
    const t = await newTicket(40);
    const older = await newJob('older', { queuedAt: new Date('2026-10-01T00:00:00Z'), costSpentUsd: new Prisma.Decimal('0.5'), costCarriedUsd: new Prisma.Decimal('0.25') });
    const newer = await newJob('newer', { queuedAt: new Date('2026-10-02T00:00:00Z') });
    await repo.linkTickets(older.id, [t.id]);
    await repo.linkTickets(newer.id, [t.id]);
    const rows = await repo.findJobsForTicket(t.id, 50);
    expect(rows.map((r) => r.feature)).toEqual(['newer', 'older']);
    expect(rows[1]).toEqual(expect.objectContaining({ costSpentUsd: '0.5', costCarriedUsd: '0.25' }));
    expect(await repo.findJobsForTicket(t.id, 1)).toHaveLength(1);
  });

  it('unlinks the join row and only that job\'s fleet links on that ticket', async () => {
    const job = await newJob('unlink');
    const other = await newJob('unlink-other');
    const t = await newTicket(50);
    await repo.linkTickets(job.id, [t.id]);
    await prisma.ticketLink.createMany({
      data: [
        { ticketId: t.id, url: 'https://github.com/acme/app/pull/1', provider: 'github', linkType: 'pr', source: 'fleet', jobId: job.id },
        { ticketId: t.id, url: 'https://github.com/acme/app/pull/2', provider: 'github', linkType: 'pr', source: 'fleet', jobId: other.id },
        { ticketId: t.id, url: 'https://github.com/acme/app/pull/3', provider: 'github', linkType: 'pr', source: 'vcs', jobId: job.id },
      ],
    });
    expect(await repo.unlink(job.id, t.id)).toBe(true);
    expect(await prisma.fleetJobTicket.count({ where: { jobId: job.id } })).toBe(0);
    expect((await prisma.ticketLink.findMany({ where: { ticketId: t.id }, orderBy: { url: 'asc' } })).map((l) => l.url)).toEqual([
      'https://github.com/acme/app/pull/2', 'https://github.com/acme/app/pull/3',
    ]);
    expect(await repo.unlink(job.id, t.id)).toBe(false);
  });
});
