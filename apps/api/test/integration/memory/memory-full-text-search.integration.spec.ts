/**
 * memory-notes US-005 (#456) — prove PostgreSQL any-word recall and REST description fallback over a project's memory.
 *
 * A non-blank `text` no longer has to be a substring of one field: the repository asks Postgres whether
 * `websearch_to_tsquery('english', text)` has any lexeme, and with lexemes it ranks every row by
 * `ts_rank("searchVector", query)` over subject, predicate, description and object — the generated column
 * the migration adds. Without lexemes (stopwords only, punctuation) the pre-feature `contains` path runs
 * unchanged, and so it does when the ranked query matches nothing, so an unsegmented (for example Chinese)
 * query still finds what a substring search found before.
 *
 * Every test writes the rows it reads; the rows are inserted directly so a test can pin `ttlAt`, `status`,
 * `deletedAt` and `updatedAt`, the fields the ranked path filters and orders on that no writer sets at will.
 *
 * Run: cd apps/api && bun run test:db:up && KODA_DB_TESTS=1 bunx vitest run test/integration/memory/memory-full-text-search.integration.spec.ts
 */
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { MemoryKind } from '../../../src/common/enums';
import type { IPageResult } from '@nathapp/nestjs-data';
import type { MemoryItem, ProjectMemoryQuery } from '../../../src/memory/memory-item-repository';
import { PrismaMemoryItemRepository } from '../../../src/memory/prisma-memory-item.repository';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { asTestActor, fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

/** The stored row fields a test pins; every other column keeps its default. */
interface ItemOverrides {
  projectId?: string;
  kind?: string;
  subject?: string;
  predicate?: string;
  object?: string | null;
  description?: string | null;
  status?: string;
  confidence?: number;
  ttlAt?: Date | null;
  deletedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

describeIntegration('memory full-text search (memory-notes US-003/US-005)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let world: FleetHttpWorld;
  /** The API's own repository, running as the system writer a direct insert is made by. */
  let repository: PrismaMemoryItemRepository;
  /** The slug `GET /projects/:slug/memory` is reached by; seeded as `web` by the fleet world. */
  let projectSlug: string;

  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** One stored memory row of the `web` project, unless the test names another. */
  let serial = 0;
  const addItem = (over: ItemOverrides = {}) =>
    db.memoryItem.create({
      data: {
        projectId: world.projectId,
        kind: MemoryKind.FACT,
        subject: `memory-subject-${++serial}`,
        predicate: 'state',
        object: 'a value',
        status: 'active',
        confidence: 0.8,
        ...over,
      },
    });

  /** The ranked/fallback page `GET /projects/:slug/memory` asks for, with `web` as the project. */
  const search = (
    text: string | undefined,
    page: { current: number; size: number } = { current: 1, size: 20 },
    over: Partial<ProjectMemoryQuery> = {},
  ): Promise<IPageResult<MemoryItem>> =>
    repository.findByProjectMemory({ projectId: world.projectId, ...over, text }, page);

  const ids = (page: IPageResult<MemoryItem>): string[] => page.records.map((item) => item.id);

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    repository = asTestActor(app.get(PrismaMemoryItemRepository), { type: 'SYSTEM', id: 'outbox' });
    projectSlug = (await db.project.findUniqueOrThrow({ where: { id: world.projectId } })).slug;
  }, 120000);

  beforeEach(async () => {
    resetThrottle(app);
    // Each test writes the rows it reads.
    await db.memoryItem.deleteMany({ where: { projectId: { in: [world.projectId, world.opsProjectId] } } });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('AC-1: a stemmed, multi-word text finds an item by its object alone', async () => {
    // "deployed runner" is a substring of no field: only the stemmed full-text match can find it.
    const item = await addItem({ subject: 'pipeline-42', predicate: 'state', object: 'the runner deploys nightly' });

    const page = await search('deployed runner');

    expect(page.total).toBe(1);
    expect(ids(page)).toEqual([item.id]);
    expect(page.records[0].object).toBe('the runner deploys nightly');
  });

  it('AC-2: a NOTE is found by its index line, which no other field mentions', async () => {
    const note = await addItem({
      kind: MemoryKind.NOTE,
      subject: 'replay-cost',
      predicate: 'project',
      object: 'The body never mentions the word.',
      description: 'budget for the replay',
    });
    // A triple kind whose texts certainly do not carry the term, so only the note can answer.
    await addItem({ subject: 'pipeline-7', predicate: 'state', object: 'green' });

    const page = await search('budget');

    expect(ids(page)).toEqual([note.id]);
    expect(page.records[0].description).toBe('budget for the replay');
  });

  it('AC-3: without orderBy the better full-text match comes first, even when it is the older row', async () => {
    const everywhere = await addItem({
      subject: 'deploy', predicate: 'deploy', object: 'deploy',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const objectOnly = await addItem({
      subject: 'pipeline-9', predicate: 'state', object: 'deploy at noon',
      updatedAt: new Date('2026-06-01T00:00:00.000Z'),
    });

    const page = await search('deploy');

    // `objectOnly` is the newer row, so only `ts_rank` can put `everywhere` first.
    expect(ids(page)).toEqual([everywhere.id, objectOnly.id]);
  });

  it('AC-4: an explicit orderBy: updatedAt wins over rank', async () => {
    const older = await addItem({
      subject: 'deploy', predicate: 'deploy', object: 'deploy',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const newer = await addItem({
      subject: 'pipeline-11', predicate: 'state', object: 'deploy tonight',
      updatedAt: new Date('2026-06-01T00:00:00.000Z'),
    });

    const page = await search('deploy', { current: 1, size: 20 }, { orderBy: 'updatedAt' });

    expect(ids(page)).toEqual([newer.id, older.id]);
  });

  it('AC-5: a text with no lexeme ("the") keeps the substring path', async () => {
    // `websearch_to_tsquery('english', 'the')` has numnode 0: the pre-feature `contains` match answers.
    const item = await addItem({ subject: 'the replay budget', predicate: 'state', object: 'held' });
    await addItem({ subject: 'pipeline-13', predicate: 'state', object: 'green' });

    const page = await search('the');

    expect(ids(page)).toEqual([item.id]);
  });

  it('AC-6: an expired TTL row is not returned when status is not given', async () => {
    await addItem({
      subject: 'deploy', predicate: 'state', object: 'deploy before',
      ttlAt: new Date('2020-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-06-01T00:00:00.000Z'),
    });
    const live = await addItem({
      subject: 'deploy', predicate: 'state', object: 'deploy after',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const page = await search('deploy');

    expect(ids(page)).toEqual([live.id]);
    expect(page.total).toBe(1);
  });

  it('AC-7: status: superseded answers only superseded matches', async () => {
    const superseded = await addItem({ subject: 'deploy', predicate: 'state', object: 'deploy old', status: 'superseded' });
    await addItem({ subject: 'deploy', predicate: 'state', object: 'deploy new', status: 'active' });

    const page = await search('deploy', { current: 1, size: 20 }, { status: 'superseded' });

    expect(ids(page)).toEqual([superseded.id]);
  });

  it('AC-8: kind: NOTE answers only note matches', async () => {
    const note = await addItem({
      kind: MemoryKind.NOTE, subject: 'deploy-plan', predicate: 'project',
      object: 'deploy steps', description: 'deploy plan',
    });
    await addItem({ subject: 'deploy', predicate: 'state', object: 'deploy now' });

    const page = await search('deploy', { current: 1, size: 20 }, { kind: MemoryKind.NOTE });

    expect(ids(page)).toEqual([note.id]);
  });

  it('AC-9: a soft-deleted match and another project\'s match are not returned', async () => {
    await addItem({ subject: 'deploy', predicate: 'state', object: 'deploy gone', deletedAt: new Date() });
    await addItem({
      projectId: world.opsProjectId, subject: 'deploy', predicate: 'state', object: 'deploy elsewhere',
    });
    const live = await addItem({ subject: 'deploy', predicate: 'state', object: 'deploy here' });

    const page = await search('deploy');

    expect(ids(page)).toEqual([live.id]);
    expect(page.total).toBe(1);
  });

  it('AC-10: three matches page as two and one with a total of three and no overlap', async () => {
    const rows = [
      await addItem({ subject: 'deploy', predicate: 'state', object: 'deploy one', updatedAt: new Date('2026-01-01T00:00:00.000Z') }),
      await addItem({ subject: 'deploy', predicate: 'state', object: 'deploy two', updatedAt: new Date('2026-03-01T00:00:00.000Z') }),
      await addItem({ subject: 'deploy', predicate: 'state', object: 'deploy three', updatedAt: new Date('2026-05-01T00:00:00.000Z') }),
    ];

    const first = await search('deploy', { current: 1, size: 2 });
    const second = await search('deploy', { current: 2, size: 2 });

    expect(first.total).toBe(3);
    expect(first.records).toHaveLength(2);
    expect(first.hasNext).toBe(true);
    expect(second.records).toHaveLength(1);
    const paged = [...ids(first), ...ids(second)];
    expect(new Set(paged).size).toBe(3);
    expect(paged.sort()).toEqual(rows.map((row) => row.id).sort());
  });

  it('AC-11: a quote and a semicolon in the text answer a page instead of an error', async () => {
    const item = await addItem({ subject: 'drop', predicate: 'state', object: "it's; drop" });

    const page = await search("it's; drop");

    // `websearch_to_tsquery` folds this to the lexeme `drop`; it is a bound parameter, never SQL text.
    expect(page.records).toHaveLength(1);
    expect(ids(page)).toEqual([item.id]);
  });

  it('AC-12: a subject prefix is literal, so a_b matches a_b and not axb', async () => {
    const literal = await addItem({ subject: 'a_b-deploy', predicate: 'state', object: 'deploy one' });
    await addItem({ subject: 'axb-deploy', predicate: 'state', object: 'deploy two' });

    const page = await search('deploy', { current: 1, size: 20 }, { subject: 'a_b' });

    expect(ids(page)).toEqual([literal.id]);
  });

  it('AC-13: an unsegmented Chinese text falls back to the substring match after zero full-text matches', async () => {
    // '预算' is one lexeme, and the generated vector holds '回放预算保持不变' as one whole run: the ranked
    // query matches nothing, so the `contains` fallback is what answers.
    const item = await addItem({ subject: 'pipeline-17', predicate: 'state', object: '回放预算保持不变' });

    const page = await search('预算');

    expect(ids(page)).toEqual([item.id]);
    expect(page.records[0].object).toBe('回放预算保持不变');
  });

  const addSpecifiedNotes = async () => {
    const fixed = {
      kind: MemoryKind.NOTE,
      predicate: 'project',
      status: 'active',
    };
    const a = await addItem({ ...fixed, subject: 'note-a', description: 'label a', object: 'API integration specs need the compose test Postgres on port 5433.' });
    await addItem({ ...fixed, subject: 'note-b', description: 'label b', object: 'Run web unit tests with bunx jest.' });
    await addItem({ ...fixed, subject: 'note-c', description: 'label c', object: 'When a budget window is exceeded, dispatch pauses.' });
    const d = await addItem({ ...fixed, subject: 'note-d', description: 'label d', object: 'Deploy runs build-images then deploy.sh, which takes a backup.', updatedAt: new Date('2026-01-01T00:00:00.000Z') });
    const e = await addItem({ ...fixed, subject: 'note-e', description: 'label e', object: 'Restore from the newest dump.', updatedAt: new Date('2026-06-01T00:00:00.000Z') });
    return { a, d, e };
  };

  it('AC-1: any-word recall ranks the PostgreSQL note first', async () => {
    const { a } = await addSpecifiedNotes();
    const page = await search('which postgres port do api integration tests use');
    expect(ids(page)[0]).toBe(a.id);
  });

  it('AC-2: rank puts the note matching two query words before one', async () => {
    const { d, e } = await addSpecifiedNotes();
    const page = await search('deploy backup restore');
    expect(ids(page).slice(0, 2)).toEqual([d.id, e.id]);
  });

  it('AC-3: all-word match excludes single-word match', async () => {
    const { d } = await addSpecifiedNotes();
    const page = await search('deploy backup');
    expect(ids(page)).toEqual([d.id]);
  });

  it('AC-4: any-word results exclude expired notes by default', async () => {
    const { a } = await addSpecifiedNotes();
    const expired = await addItem({
      kind: MemoryKind.NOTE, subject: 'expired-note', predicate: 'project', description: 'expired',
      object: 'Postgres was used before.', ttlAt: new Date('2020-01-01T00:00:00.000Z'),
    });
    const page = await search('postgres widget');
    expect(ids(page)).toContain(a.id);
    expect(ids(page)).not.toContain(expired.id);
  });

  it('AC-5: any-word results preserve the kind filter', async () => {
    const { a } = await addSpecifiedNotes();
    const fact = await addItem({ kind: MemoryKind.FACT, subject: 'postgres fact', predicate: 'uses', object: 'Postgres widget.' });
    const page = await search('postgres widget', { current: 1, size: 20 }, { kind: MemoryKind.NOTE });
    expect(ids(page)).toContain(a.id);
    expect(ids(page)).not.toContain(fact.id);
  });

  it('AC-6: any-word results page without overlap and retain their total', async () => {
    const { d, e } = await addSpecifiedNotes();
    const first = await search('deploy backup restore', { current: 1, size: 1 });
    const second = await search('deploy backup restore', { current: 2, size: 1 });
    expect(first.records).toHaveLength(1);
    expect(second.records).toHaveLength(1);
    expect(ids(first)[0]).not.toBe(ids(second)[0]);
    expect(first.total).toBe(2);
    expect(second.total).toBe(2);
    expect(new Set([ids(first)[0], ids(second)[0]])).toEqual(new Set([d.id, e.id]));
  });

  it('AC-7: explicit updatedAt ordering wins over relevance rank', async () => {
    const { d, e } = await addSpecifiedNotes();
    const page = await search('deploy backup restore', { current: 1, size: 20 }, { orderBy: 'updatedAt' });
    expect(ids(page).slice(0, 2)).toEqual([e.id, d.id]);
  });

  it('AC-8: REST text search finds a Chinese description substring', async () => {
    const item = await addItem({
      kind: MemoryKind.NOTE, subject: 'chinese-search', predicate: 'project',
      description: '中文搜索使用子串匹配', object: '全文检索找不到中文词时改用子串匹配',
    });
    const response = await request(server())
      .get(`/api/projects/${projectSlug}/memory?text=${encodeURIComponent('中文搜索')}`)
      .set(auth(world.tokens.dev))
      .expect(200);
    const page = data<IPageResult<{ id: string }>>(response);
    expect(page.records.map((record) => record.id)).toContain(item.id);
  });

  it('AC-17: GET /projects/:slug/memory?text=deployed answers the ranked item for a member', async () => {
    const item = await addItem({ subject: 'pipeline-19', predicate: 'state', object: 'the runner deploys nightly' });
    // A decoy the same project holds: without the `text` filter the route would answer both.
    await addItem({ subject: 'pipeline-20', predicate: 'state', object: 'nothing to see here' });

    const response = await request(server())
      .get(`/api/projects/${projectSlug}/memory?text=deployed`)
      .set(auth(world.tokens.dev))
      .expect(200);

    const page = data<IPageResult<{ id: string; object?: string }>>(response);
    expect(page.total).toBe(1);
    expect(page.records.map((record) => record.id)).toEqual([item.id]);
    expect(page.records[0].object).toBe('the runner deploys nightly');
  });
});
