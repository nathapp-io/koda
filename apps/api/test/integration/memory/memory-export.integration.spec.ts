/**
 * memory-notes US-006 (#379) — `GET /projects/:slug/memory/export`: the incremental memory feed a mirror
 * replays.
 *
 * The only keyset read before this story was `findActiveAfterId` — by id, active rows only — so a row that was
 * superseded, retired or soft-deleted simply vanished from the feed and a mirror could never forget it. The
 * export is keyed on `(updatedAt, id)` instead: a supersede, retire or soft delete goes through `update`,
 * which rewrites `updatedAt`, so the change reappears after the cursor the caller holds. Every status, kind
 * and soft-deleted row is answered with its stored `deletedAt`; only the caller's own user rows join the
 * project's, exactly the authorized union the list reads.
 *
 * Two rules shape every case below:
 *   * the settle window — a row whose `updatedAt` is inside `MEMORY_EXPORT_SETTLE_MS` (5000 ms) of the server
 *     clock is held back for the next call, so a late commit with an earlier `updatedAt` is never skipped.
 *     The rows here are therefore written with a pinned, already-settled `updatedAt` instead of being slept
 *     on: `settled()` is a fixed 60 s in the past.
 *   * the cursor is opaque — every continuation below is the `nextCursor` the previous call answered, never a
 *     cursor this file built.
 *
 * Names used here: project P is the seeded `web` project (slug `web`), the `ops` project is P's neighbour;
 * agent A is `alice` and agent B is `bob`, both rostered in P only; `dev` is a developer of P and `outsider`
 * is no member of it.
 *
 * Run: cd apps/api && bun run test:db:up &&
 *      KODA_DB_TESTS=1 bunx vitest run test/integration/memory/memory-export.integration.spec.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import type { IPageResult } from '@nathapp/nestjs-data';
import { MemoryKind } from '../../../src/common/enums';
import { PrismaMemoryItemRepository } from '../../../src/memory/prisma-memory-item.repository';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { grantRole, revokeProjectRoles } from '../../../src/permissions/test-helpers/permission-fixtures';
import { asTestActor, fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { rosterFleetAgent, seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

/** `memory.export.-2` — the sentence an unreadable cursor is answered with, naming the field it refused. */
const MEMORY_CATALOG = JSON.parse(
  readFileSync(join(__dirname, '../../../src/i18n/en/memory.json'), 'utf8'),
) as Record<string, unknown>;
const INVALID_EXPORT_FIELD = (MEMORY_CATALOG.export as Record<string, string>)['-2'];

/**
 * The 403 sentence of one refusing namespace: `permissions.40003` for a refused key, `projects.40003` for a
 * refused project access. `projects` declares no such entry, so a membership refusal ships the raw key — which
 * is exactly what tells the two apart.
 */
const refusalMessage = (namespace: 'permissions' | 'projects'): string => {
  const messages = JSON.parse(
    readFileSync(join(__dirname, `../../../src/i18n/en/${namespace}.json`), 'utf8'),
  ) as Record<string, string>;
  return messages['40003'] ?? `${namespace}.40003`;
};

/** One exported row as the JSON feed carries it. */
interface ExportedItem {
  id: string;
  status: string;
  updatedAt: string;
  deletedAt?: string | null;
  description?: string;
  subject: string;
  scope: string;
  projectId: string | null;
  ownerKey?: string;
}

/** The export page: the rows, the cursor that continues after the last of them, and whether it was full. */
interface ExportPage {
  items: ExportedItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** One stored row's fields a case pins; every other column keeps its default. */
interface ItemOverrides {
  projectId?: string | null;
  scope?: string;
  ownerKey?: string;
  ownerId?: string;
  ownerType?: string;
  kind?: string;
  subject?: string;
  predicate?: string;
  object?: string | null;
  description?: string | null;
  activeKey?: string | null;
  status?: string;
  ttlAt?: Date | null;
  deletedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

describeIntegration('memory export feed (memory-notes US-006)', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let alice: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let bob: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  /** The API's own repository, running as the system writer a direct supersede is made by. */
  let repository: PrismaMemoryItemRepository;
  /** The custom role AC-15 uses: it reaches the project and holds nothing memory-shaped. */
  const READ_ONLY_ROLE = 'export-project-reader';

  const server = () => app.getHttpServer();
  const auth = (credential: string) => ({ Authorization: `Bearer ${credential}` });

  /**
   * A timestamp the settle window cannot hold back: 60 s in the past, optionally later into that same window.
   * Rows are written with it instead of being slept on, so a case never depends on how fast the suite runs.
   */
  const settled = (offsetMs = 0): Date => new Date(Date.now() - 60_000 + offsetMs);

  /**
   * Move a row's `updatedAt` after a write the settle window would otherwise hold back. Raw SQL, because
   * Prisma's `@updatedAt` stamps its own clock on every client write — this is a fixture clock, not a wait.
   */
  const age = async (id: string | string[], updatedAt: Date): Promise<void> => {
    for (const one of [id].flat()) {
      await db.$executeRaw`UPDATE "MemoryItem" SET "updatedAt" = ${updatedAt} WHERE "id" = ${one}`;
    }
  };

  let serial = 0;
  /**
   * One stored row of project P, unless the case names another project (a user row names none), with its
   * `updatedAt` pinned by `age` rather than left to the writer's clock: the settle window is the one rule every
   * case below has to be able to step over deterministically.
   */
  const addItem = async (over: ItemOverrides = {}) => {
    const { updatedAt, ...rest } = over;
    const created = await db.memoryItem.create({
      data: {
        projectId: world.projectId,
        kind: MemoryKind.NOTE,
        subject: `export-subject-${++serial}`,
        predicate: 'project',
        object: 'Replay budget stays 2,048 MiB.',
        description: 'replay budget',
        status: 'active',
        ...rest,
      },
    });
    const stamped = updatedAt ?? settled();
    await age(created.id, stamped);
    return { ...created, updatedAt: stamped };
  };

  /** One export call by `credential`, answering its page. */
  const exportBy = (credential: string, query: Record<string, string> = {}) =>
    request(server()).get('/api/projects/web/memory/export').query(query).set(auth(credential));

  const exportPage = async (credential: string, query: Record<string, string> = {}): Promise<ExportPage> =>
    data<ExportPage>(await exportBy(credential, query).expect(200));

  const ids = (page: ExportPage): string[] => page.items.map((item) => item.id);

  /** `GET /projects/web/memory` — the list AC-17 proves the export did not widen. */
  const list = async (credential: string): Promise<IPageResult<ExportedItem>> =>
    data<IPageResult<ExportedItem>>(
      await request(server()).get('/api/projects/web/memory').set(auth(credential)).expect(200),
    );

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    alice = await seedFleetHttpAgent(server(), world.tokens.root);
    bob = await seedFleetHttpAgent(server(), world.tokens.root);
    // Both agents are rostered in P only, so neither is an outsider to the feed.
    await rosterFleetAgent(db, alice.id, world.projectId);
    await rosterFleetAgent(db, bob.id, world.projectId);
    // AC-15: `project.read` admits the caller to the project; memory.read is then what the route refuses.
    await db.role.create({
      data: { key: READ_ONLY_ROLE, name: READ_ONLY_ROLE, scope: 'PROJECT', system: false, permissions: ['project.read'] },
    });
    // The seeded `viewer` holds the viewer role (`*.read`, so memory.read too). Replacing it with the custom
    // role leaves a member of P that can reach the project and holds nothing memory-shaped.
    await revokeProjectRoles(db, { type: 'USER', id: world.ids.viewer }, world.projectId);
    await grantRole(db, { type: 'USER', id: world.ids.viewer }, READ_ONLY_ROLE, world.projectId);
    // The rows and bindings above were written after a principal could have been cached by an earlier check.
    await app.get(PermissionCache).invalidate();
    repository = asTestActor(app.get(PrismaMemoryItemRepository), { type: 'SYSTEM', id: 'outbox' });
  }, 120_000);

  beforeEach(async () => {
    resetThrottle(app);
    // Each case writes the rows it reads.
    await db.memoryItem.deleteMany({ where: { projectId: { in: [world.projectId, world.opsProjectId] } } });
    await db.memoryItem.deleteMany({ where: { ownerKey: { in: [`AGENT:${alice.id}`, `AGENT:${bob.id}`] } } });
  });

  afterAll(async () => {
    await app?.close();
  });

  // -------------------------------------------------------------------------
  // AC-5 — the whole project, every status, ordered by (updatedAt, id)
  // -------------------------------------------------------------------------

  it('AC-5: an export with no since answers every row of P, superseded, rejected and soft-deleted included', async () => {
    const active = await addItem({ subject: 'export-active', updatedAt: settled() });
    const superseded = await addItem({ subject: 'export-superseded', status: 'superseded', activeKey: null, updatedAt: settled(1_000) });
    const rejected = await addItem({ subject: 'export-rejected', status: 'rejected', activeKey: null, updatedAt: settled(2_000) });
    const deleted = await addItem({ subject: 'export-deleted', deletedAt: new Date('2026-01-01T00:00:00.000Z'), updatedAt: settled(3_000) });

    const page = await exportPage(world.tokens.dev);

    expect(ids(page)).toEqual([active.id, superseded.id, rejected.id, deleted.id]);
    expect(page.items.map((item) => item.status)).toEqual(['active', 'superseded', 'rejected', 'active']);
    // The soft-deleted row carries the moment it was deleted: that is the change a mirror replays.
    expect(page.items[3]).toMatchObject({ id: deleted.id, deletedAt: '2026-01-01T00:00:00.000Z' });
    expect(page.items[0].deletedAt ?? null).toBeNull();
    expect(page.hasMore).toBe(false);
  });

  it('AC-5: two rows of the same updatedAt are ordered by id', async () => {
    const stamp = settled();
    const first = await addItem({ subject: 'export-tie-a', updatedAt: stamp });
    const second = await addItem({ subject: 'export-tie-b', updatedAt: stamp });

    const page = await exportPage(world.tokens.dev);

    expect(ids(page)).toEqual([first.id, second.id].sort());
  });

  // -------------------------------------------------------------------------
  // AC-6 — the settle window
  // -------------------------------------------------------------------------

  it('AC-6: a row updated less than 5000 ms before the server clock is held back', async () => {
    const settled1 = await addItem({ subject: 'export-settled', updatedAt: settled() });
    const fresh = await addItem({ subject: 'export-fresh', updatedAt: new Date(Date.now() - 1_000) });

    const page = await exportPage(world.tokens.dev);

    expect(ids(page)).toEqual([settled1.id]);
    expect(ids(page)).not.toContain(fresh.id);
  });

  // -------------------------------------------------------------------------
  // AC-7 / AC-8 — paging by the cursor
  // -------------------------------------------------------------------------

  it('AC-7: 3 rows with take=2 answer two rows and a cursor, then the third with hasMore false', async () => {
    const rows = [
      await addItem({ subject: 'export-page-1', updatedAt: settled() }),
      await addItem({ subject: 'export-page-2', updatedAt: settled(1_000) }),
      await addItem({ subject: 'export-page-3', updatedAt: settled(2_000) }),
    ];

    const first = await exportPage(world.tokens.dev, { take: '2' });
    expect(ids(first)).toEqual([rows[0].id, rows[1].id]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    const second = await exportPage(world.tokens.dev, { take: '2', since: String(first.nextCursor) });
    expect(ids(second)).toEqual([rows[2].id]);
    expect(second.hasMore).toBe(false);
  });

  it('AC-8: two rows sharing an updatedAt split by take=1 are each answered exactly once', async () => {
    const stamp = settled();
    const left = await addItem({ subject: 'export-split-a', updatedAt: stamp });
    const right = await addItem({ subject: 'export-split-b', updatedAt: stamp });

    const first = await exportPage(world.tokens.dev, { take: '1' });
    const second = await exportPage(world.tokens.dev, { take: '1', since: String(first.nextCursor) });

    expect([...ids(first), ...ids(second)].sort()).toEqual([left.id, right.id].sort());
    expect(new Set([...ids(first), ...ids(second)]).size).toBe(2);
    expect(first.hasMore).toBe(true);
  });

  // -------------------------------------------------------------------------
  // AC-9 — a change to a row already exported comes back
  // -------------------------------------------------------------------------

  it('AC-9: a superseded row is answered again after the earlier cursor, with status superseded', async () => {
    const first = await addItem({
      subject: 'export-replay-budget', predicate: 'project', activeKey: 'NOTE:export-replay-budget',
      object: 'Replay budget stays 2,048 MiB.',
    });

    const exported = await exportPage(world.tokens.dev);
    expect(ids(exported)).toEqual([first.id]);
    const cursor = String(exported.nextCursor);

    // The real supersede: the same slug re-saved replaces the note and stamps a new `updatedAt` on the old row.
    const replacement = await repository.upsert({
      projectId: world.projectId, kind: MemoryKind.NOTE, subject: 'export-replay-budget', predicate: 'project',
      object: 'Replay budget is now 4,096 MiB.', description: 'replay budget, raised',
    });
    const supersededRow = await db.memoryItem.findUniqueOrThrow({ where: { id: first.id } });
    expect(supersededRow.status).toBe('superseded');
    expect(supersededRow.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());
    // The settle window would hold both writes back; the fixture clock moves them past it, not a wait.
    await age([first.id, replacement.id], settled(1_000));

    const replay = await exportPage(world.tokens.dev, { since: cursor });

    expect(ids(replay)).toEqual(expect.arrayContaining([first.id, replacement.id]));
    expect(replay.items.find((item) => item.id === first.id)).toMatchObject({ status: 'superseded' });
    expect(replay.items.find((item) => item.id === replacement.id)).toMatchObject({ status: 'active' });
  });

  // -------------------------------------------------------------------------
  // AC-10 — the cursors an empty page carries
  // -------------------------------------------------------------------------

  it('AC-10: an empty page echoes the since it was given', async () => {
    const only = await addItem({ subject: 'export-empty', updatedAt: settled() });
    const exported = await exportPage(world.tokens.dev);
    expect(ids(exported)).toEqual([only.id]);
    const cursor = String(exported.nextCursor);

    const empty = await exportPage(world.tokens.dev, { since: cursor });

    expect(empty).toEqual({ items: [], nextCursor: cursor, hasMore: false });
  });

  it('AC-10: an empty page with no since answers a null cursor', async () => {
    const empty = await exportPage(world.tokens.root, {});

    // `root` reads the `web` project, which this case left without a single row.
    expect(empty).toEqual({ items: [], nextCursor: null, hasMore: false });

    // And a project with no memory at all answers the same.
    const elsewhere = data<ExportPage>(
      await request(server()).get('/api/projects/ops/memory/export').set(auth(world.tokens.root)).expect(200),
    );
    expect(elsewhere).toEqual({ items: [], nextCursor: null, hasMore: false });
  });

  // -------------------------------------------------------------------------
  // AC-11 — the authorized union: P's rows plus the caller's own user rows
  // -------------------------------------------------------------------------

  it('AC-11: agent A exports its own user rows and never B\'s or another project\'s', async () => {
    const mine = await addItem({
      projectId: null, scope: 'user', ownerKey: `AGENT:${alice.id}`, ownerId: alice.id, ownerType: 'AGENT',
      subject: 'export-alice-note', updatedAt: settled(),
    });
    const theirs = await addItem({
      projectId: null, scope: 'user', ownerKey: `AGENT:${bob.id}`, ownerId: bob.id, ownerType: 'AGENT',
      subject: 'export-bob-note', updatedAt: settled(1_000),
    });
    const project = await addItem({ subject: 'export-project-note', updatedAt: settled(2_000) });
    const foreign = await addItem({ projectId: world.opsProjectId, subject: 'export-foreign-note', updatedAt: settled(3_000) });

    const page = await exportPage(alice.apiKey);

    expect(ids(page)).toEqual([mine.id, project.id]);
    expect(ids(page)).not.toContain(theirs.id);
    expect(ids(page)).not.toContain(foreign.id);
    expect(page.items.find((item) => item.id === mine.id)).toMatchObject({
      scope: 'user', projectId: null, ownerKey: `AGENT:${alice.id}`,
    });
  });

  // -------------------------------------------------------------------------
  // AC-12 .. AC-16 — the route's refusals
  // -------------------------------------------------------------------------

  it('AC-12: an unreadable since answers 400 naming since', async () => {
    const response = await exportBy(world.tokens.dev, { since: 'garbage' }).expect(400);

    expect(response.body).toMatchObject({ ret: -2, message: INVALID_EXPORT_FIELD.replace('{field}', 'since') });
  });

  it('AC-13: a non-member answers 403 and an unknown slug 404', async () => {
    const outsider = await exportBy(world.tokens.outsider).expect(403);
    // A non-member is refused by project access, before the route key is even asked for.
    expect(outsider.body).toMatchObject({ ret: 40003, message: refusalMessage('projects') });

    const unknown = await request(server()).get('/api/projects/no-such-project/memory/export')
      .set(auth(world.tokens.dev)).expect(404);
    expect(unknown.body.ret).toBe(404);
  });

  it('AC-14: a take outside 1..500 or not an integer answers 400 naming take', async () => {
    for (const take of ['0', '501', '1.5']) {
      const response = await exportBy(world.tokens.dev, { take }).expect(400);
      expect(JSON.stringify(response.body)).toContain('take');
    }
  });

  it('AC-15: a member without memory.read answers 403', async () => {
    const refused = await exportBy(world.tokens.viewer).expect(403);

    // The key's sentence, not the membership one: the caller does reach the project below.
    expect(refused.body).toMatchObject({ ret: 40003, message: refusalMessage('permissions') });
    await request(server()).get('/api/projects/web').set(auth(world.tokens.viewer)).expect(200);
  });

  it('AC-16: a soft-deleted project slug answers 404', async () => {
    const created = data<{ id: string }>(
      await request(server()).post('/api/projects').set(auth(world.tokens.root))
        .send({ name: 'Gone', slug: 'gone', key: 'GONE' }).expect(201),
    );
    await db.project.update({ where: { id: created.id }, data: { deletedAt: new Date() } });

    await request(server()).get('/api/projects/gone/memory/export').set(auth(world.tokens.root)).expect(404);
  });

  // -------------------------------------------------------------------------
  // AC-17 — the list's eligibility rules are unchanged
  // -------------------------------------------------------------------------

  it('AC-17: the list without status still excludes superseded, rejected, expired and soft-deleted rows', async () => {
    const active = await addItem({ subject: 'export-list-active', updatedAt: settled() });
    await addItem({ subject: 'export-list-superseded', status: 'superseded', activeKey: null, updatedAt: settled(1_000) });
    await addItem({ subject: 'export-list-rejected', status: 'rejected', activeKey: null, updatedAt: settled(2_000) });
    await addItem({
      subject: 'export-list-expired', ttlAt: new Date('2020-01-01T00:00:00.000Z'), updatedAt: settled(3_000),
    });
    await addItem({ subject: 'export-list-deleted', deletedAt: new Date('2026-01-01T00:00:00.000Z'), updatedAt: settled(4_000) });

    const page = await list(world.tokens.dev);

    expect(page.records.map((record) => record.id)).toEqual([active.id]);
    expect(page.total).toBe(1);
  });
});
