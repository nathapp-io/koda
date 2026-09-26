// apps/api/test/integration/memory/timeline-pagination.integration.spec.ts
/**
 * Slice 3 / M20 — the timeline pages across ticket, agent and decision events
 * with a (createdAt, id) keyset; every event appears exactly once.
 * Run: cd apps/api && bun run test:db:up && KODA_DB_TESTS=1 bunx jest test/integration/memory/timeline-pagination
 */
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { PrismaTimelineRepository } from '../../../src/memory/prisma-timeline.repository';
import { TimelineService } from '../../../src/memory/timeline.service';
import { resetDb } from '../../helpers/reset-db';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('timeline keyset pagination (PG)', () => {
  let prisma: PrismaService<PrismaClient>;
  let service: TimelineService;
  let projectId: string;
  // Newest first, as the API must return them. Ids are lowercase alphanumeric
  // (no '-' / '_': glibc collations ignore punctuation, which would make the
  // database order disagree with code-unit order).
  const expected: string[] = [];

  const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute, 0, 0));
  const TIE = at(30);

  beforeAll(async () => {
    await resetDb();
    prisma = new PrismaService({ client: PrismaClient, clientOptions: { datasources: { db: { url: DATABASE_URL } } } });
    await prisma.onModuleInit();
    service = new TimelineService(new PrismaTimelineRepository(prisma));

    const project = await prisma.client.project.create({ data: { name: 'TL', slug: 'tl', key: 'TL' } });
    projectId = project.id;

    // Interleave the three tables minute by minute: minute m goes to table m % 3.
    const seeded: Array<{ id: string; createdAt: Date }> = [];
    for (let m = 0; m < 12; m++) {
      const id = `ev${String(m).padStart(2, '0')}`;
      const createdAt = at(m);
      if (m % 3 === 0) {
        await prisma.client.ticketEvent.create({ data: { id, projectId, action: 'x', actorId: 'u1', actorType: 'user', source: 'api', createdAt } });
      } else if (m % 3 === 1) {
        await prisma.client.agentEvent.create({ data: { id, projectId, agentId: 'a1', action: 'x', actorId: 'a1', source: 'api', createdAt } });
      } else {
        await prisma.client.decisionEvent.create({ data: { id, projectId, agentId: 'a1', action: 'x', decision: 'decided', source: 'api', createdAt } });
      }
      seeded.push({ id, createdAt });
    }
    // Same-createdAt tie spread across all three tables; order is decided by id.
    await prisma.client.ticketEvent.create({ data: { id: 'tieb', projectId, action: 'x', actorId: 'u1', actorType: 'user', source: 'api', createdAt: TIE } });
    await prisma.client.agentEvent.create({ data: { id: 'tiea', projectId, agentId: 'a1', action: 'x', actorId: 'a1', source: 'api', createdAt: TIE } });
    await prisma.client.decisionEvent.create({ data: { id: 'tiec', projectId, agentId: 'a1', action: 'x', decision: 'decided', source: 'api', createdAt: TIE } });
    seeded.push({ id: 'tieb', createdAt: TIE }, { id: 'tiea', createdAt: TIE }, { id: 'tiec', createdAt: TIE });

    seeded
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id > b.id ? -1 : 1))
      .forEach((e) => expected.push(e.id));
  });

  afterAll(async () => {
    await prisma.client.$disconnect();
  });

  async function walk(limit: number, extra: { from?: Date; to?: Date } = {}): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 50; guard++) {
      const page = await service.getProjectTimeline({ projectId, limit, cursor, ...extra });
      seen.push(...page.events.map((e) => e.id));
      if (!page.nextCursor) return seen;
      cursor = page.nextCursor;
    }
    throw new Error('pagination did not terminate');
  }

  it.each([1, 2, 4, 15, 100])('returns every event exactly once in order with limit=%i', async (limit) => {
    expect(await walk(limit)).toEqual(expected);
  });

  it('keeps the tie ordered by id across tables', async () => {
    const ids = await walk(2);
    expect(ids.indexOf('tiec')).toBeLessThan(ids.indexOf('tieb'));
    expect(ids.indexOf('tieb')).toBeLessThan(ids.indexOf('tiea'));
  });

  it('honours a from/to window while paging', async () => {
    const from = at(3);
    const to = at(8);
    const inWindow = expected.filter((id) => /^ev\d+$/.test(id) && Number(id.slice(2)) >= 3 && Number(id.slice(2)) <= 8);
    expect(await walk(2, { from, to })).toEqual(inWindow);
  });
});
