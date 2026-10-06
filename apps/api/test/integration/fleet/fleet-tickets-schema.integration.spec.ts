/**
 * Fleet C9 slice 1a — FleetJobTicket and TicketLink.source/jobId (PG), spec §1.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-tickets-schema.integration.spec.ts
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('fleet tickets schema (PG)', () => {
  const prisma = new PrismaClient();
  let projectId: string;
  let repoId: string;
  let userId: string;

  const newJob = (feature: string) =>
    prisma.fleetJob.create({
      data: {
        projectId, repoId, ref: 'main', command: 'RUN', feature, profiles: [],
        maxCostUsd: new Prisma.Decimal('1'), selectorLabels: [], requestedById: userId,
      },
    });
  const newTicket = (number: number) =>
    prisma.ticket.create({ data: { projectId, number, type: 'TASK', title: `t${number}` } });

  beforeAll(async () => {
    await resetDb();
    const user = await prisma.user.create({ data: { email: 'u@koda.test', passwordHash: 'x', role: 'ADMIN' } });
    const project = await prisma.project.create({ data: { name: 'P', slug: 'p', key: 'P' } });
    const repo = await prisma.fleetRepo.create({
      data: { projectId: project.id, provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', createdById: user.id },
    });
    userId = user.id;
    projectId = project.id;
    repoId = repo.id;
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('links a job to many tickets and refuses a duplicate pair', async () => {
    const job = await newJob('many');
    const [a, b] = [await newTicket(1), await newTicket(2)];
    await prisma.fleetJobTicket.createMany({ data: [{ jobId: job.id, ticketId: a.id }, { jobId: job.id, ticketId: b.id }] });
    expect(await prisma.fleetJobTicket.count({ where: { jobId: job.id } })).toBe(2);
    await expect(prisma.fleetJobTicket.create({ data: { jobId: job.id, ticketId: a.id } })).rejects.toThrow();
  });

  it('cascades from both sides', async () => {
    const job = await newJob('cascade');
    const t = await newTicket(3);
    await prisma.fleetJobTicket.create({ data: { jobId: job.id, ticketId: t.id } });
    await prisma.ticket.delete({ where: { id: t.id } });
    expect(await prisma.fleetJobTicket.count({ where: { jobId: job.id } })).toBe(0);
    const t2 = await newTicket(4);
    await prisma.fleetJobTicket.create({ data: { jobId: job.id, ticketId: t2.id } });
    await prisma.fleetJob.delete({ where: { id: job.id } });
    expect(await prisma.fleetJobTicket.count({ where: { ticketId: t2.id } })).toBe(0);
  });

  it('defaults TicketLink.source to vcs and nulls jobId when the job goes', async () => {
    const t = await newTicket(5);
    const plain = await prisma.ticketLink.create({ data: { ticketId: t.id, url: 'https://x.test/1', provider: 'other' } });
    expect(plain).toEqual(expect.objectContaining({ source: 'vcs', jobId: null }));
    const job = await newJob('pr');
    const fleet = await prisma.ticketLink.create({
      data: { ticketId: t.id, url: 'https://github.com/acme/app/pull/9', provider: 'github', linkType: 'pr', source: 'fleet', jobId: job.id },
    });
    await prisma.fleetJob.delete({ where: { id: job.id } });
    expect(await prisma.ticketLink.findUniqueOrThrow({ where: { id: fleet.id } })).toEqual(expect.objectContaining({ source: 'fleet', jobId: null }));
  });
});
