/**
 * memory-notes US-005 (#378) — reading a principal's user-scoped notes next to a project's memory.
 *
 * A user note has no `projectId` of its own and is keyed on `<ownerType>:<ownerId>` (US-004), so a read that
 * names the caller as its `owner` answers the project's rows *plus* the caller's user rows, and never another
 * principal's. Reads that name no owner stay project-only whatever `scope` asks — nothing then keys a user row.
 *
 * Names used here: agent A is `alice`, agent B is `bob`; project P is the seeded `web` project. Every case writes
 * the rows it reads.
 *
 * Run: cd apps/api && bun run test:db:up &&
 *      KODA_DB_TESTS=1 bunx vitest run test/integration/memory/memory-user-scope-read.integration.spec.ts
 */
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import type { IPageResult } from '@nathapp/nestjs-data';
import { MemoryKind } from '../../../src/common/enums';
import type { MemoryItem } from '../../../src/memory/memory-item-repository';
import { PrismaMemoryItemRepository } from '../../../src/memory/prisma-memory-item.repository';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { asTestActor, fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { rosterFleetAgent, seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

/** The fields of a listed record these cases read. */
interface ListedItem {
  id: string;
  scope: string;
  projectId: string | null;
  kind: string;
  subject: string;
  description?: string;
  ownerKey?: string;
}

describeIntegration('memory user scope reads (memory-notes US-005)', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let alice: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let bob: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  /** The API's own repository, running as the system actor a direct call is made by. */
  let repository: PrismaMemoryItemRepository;
  /** The slug project P is reached by. */
  let projectSlug: string;

  const server = () => app.getHttpServer();
  const auth = (credential: string) => ({ Authorization: `Bearer ${credential}` });

  /** `POST /memory` in project P: 201, as a member's direct write answers. */
  const post = async (credential: string, body: Record<string, unknown>): Promise<string> => {
    const response = await request(server()).post('/api/memory').set(auth(credential))
      .send({ projectId: world.projectId, ...body }).expect(201);
    return data<{ id: string }>(response).id;
  };

  /** The user-scoped note a principal owns; every case changes what it is about. */
  const userNote = (over: Record<string, unknown> = {}) => ({
    scope: 'user',
    kind: MemoryKind.NOTE,
    subject: 'working-style',
    predicate: 'user',
    object: 'Prefers small commits with a test each.',
    description: 'small commits',
    ...over,
  });

  /** A row of project P, so a page has both sides of the union to tell apart. */
  const projectNote = (over: Record<string, unknown> = {}) => ({
    kind: MemoryKind.NOTE,
    subject: 'project-review-day',
    predicate: 'project',
    object: 'This project reviews on Fridays.',
    description: 'friday reviews',
    ...over,
  });

  /** `GET /projects/P/memory` by `credential`, with the filters a case names. */
  const list = (credential: string, query: Record<string, string> = {}) =>
    request(server()).get(`/api/projects/${projectSlug}/memory`).query(query).set(auth(credential));

  const page = async (credential: string, query: Record<string, string> = {}): Promise<IPageResult<ListedItem>> =>
    data<IPageResult<ListedItem>>(await list(credential, query).expect(200));

  const ids = (result: IPageResult<ListedItem>): string[] => result.records.map((record) => record.id);

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    alice = await seedFleetHttpAgent(server(), world.tokens.root);
    bob = await seedFleetHttpAgent(server(), world.tokens.root);
    // Both agents are members of project P only, so neither is an outsider to the read.
    await rosterFleetAgent(db, alice.id, world.projectId);
    await rosterFleetAgent(db, bob.id, world.projectId);
    await app.get(PermissionCache).invalidate();
    repository = asTestActor(app.get(PrismaMemoryItemRepository), { type: 'SYSTEM', id: 'outbox' });
    projectSlug = (await db.project.findUniqueOrThrow({ where: { id: world.projectId } })).slug;
  }, 120000);

  beforeEach(async () => {
    resetThrottle(app);
    // Each case writes the rows it reads.
    await db.memoryItem.deleteMany();
  });

  afterAll(async () => {
    await app?.close();
  });

  // -------------------------------------------------------------------------
  // AC-1 — the caller's page is the union of P's rows and its own user notes
  // -------------------------------------------------------------------------

  it('AC-1: a member reads the project rows and its own user note, each tagged with its scope', async () => {
    const project = await post(alice.apiKey, projectNote());
    const mine = await post(alice.apiKey, userNote());

    const result = await page(alice.apiKey);

    expect(ids(result)).toEqual(expect.arrayContaining([project, mine]));
    expect(result.records.find((record) => record.id === project)).toMatchObject({
      scope: 'project', projectId: world.projectId, subject: 'project-review-day',
    });
    expect(result.records.find((record) => record.id === mine)).toMatchObject({
      scope: 'user', projectId: null, subject: 'working-style', ownerKey: `AGENT:${alice.id}`,
    });
    // Every record carries one of the two scopes: there is no untagged row.
    expect(new Set(result.records.map((record) => record.scope))).toEqual(new Set(['project', 'user']));
  });

  // -------------------------------------------------------------------------
  // AC-2 — A's page never holds B's user notes
  // -------------------------------------------------------------------------

  it("AC-2: a member's page does not answer another principal's user note", async () => {
    const mine = await post(alice.apiKey, userNote({ subject: 'alice-style' }));
    const theirs = await post(bob.apiKey, userNote({ subject: 'bob-style', object: 'Prefers squashed merges.' }));

    const result = await page(alice.apiKey);

    expect(ids(result)).toContain(mine);
    expect(ids(result)).not.toContain(theirs);
    // Nor does the other note exist as a record of any scope in A's page.
    expect(result.records.map((record) => record.ownerKey ?? null)).not.toContain(`AGENT:${bob.id}`);
  });

  // -------------------------------------------------------------------------
  // AC-3 — scope narrows the union to one side
  // -------------------------------------------------------------------------

  it("AC-3: scope user answers only the caller's user notes and scope project only P's rows", async () => {
    const project = await post(alice.apiKey, projectNote());
    const mine = await post(alice.apiKey, userNote({ subject: 'alice-style' }));
    // B's note proves the user side is the caller's, not "every user row".
    await post(bob.apiKey, userNote({ subject: 'bob-style' }));

    const userPage = await page(alice.apiKey, { scope: 'user' });
    expect(ids(userPage)).toEqual([mine]);
    expect(userPage.records.every((record) => record.scope === 'user')).toBe(true);
    expect(userPage.records[0]).toMatchObject({ projectId: null, ownerKey: `AGENT:${alice.id}` });

    const projectPage = await page(alice.apiKey, { scope: 'project' });
    expect(ids(projectPage)).toEqual([project]);
    expect(projectPage.records.every((record) => record.scope === 'project')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // AC-5 — the full-text path finds a user note by its index line
  // -------------------------------------------------------------------------

  it('AC-5: a text carried only by the index line finds the user note through the full-text path', async () => {
    // `working` is in the description alone. The substring path reads subject, predicate and object, so only
    // the ranked full-text path — whose generated vector includes `description` — can answer this note.
    const note = await post(alice.apiKey, userNote({
      subject: 'commit-style', object: 'Prefers small commits.', description: 'working agreements',
    }));
    await post(alice.apiKey, projectNote());

    const result = await page(alice.apiKey, { text: 'working' });

    expect(ids(result)).toEqual([note]);
    expect(result.records[0]).toMatchObject({ scope: 'user', description: 'working agreements' });
  });

  // -------------------------------------------------------------------------
  // AC-6 — the substring path still finds a user note when the text has no lexeme
  // -------------------------------------------------------------------------

  it('AC-6: a stopword text finds the user note by its subject through the substring path', async () => {
    // `the` is an English stopword: `websearch_to_tsquery` keeps no lexeme for it, so the pre-feature
    // `contains` path answers, and only the note's subject carries the substring.
    const note = await post(alice.apiKey, userNote({
      subject: 'the-working-style', object: 'Prefers small commits.', description: 'small commits',
    }));
    await post(alice.apiKey, projectNote());

    const result = await page(alice.apiKey, { text: 'the' });

    expect(ids(result)).toEqual([note]);
    expect(result.records[0]).toMatchObject({ scope: 'user', subject: 'the-working-style' });
  });

  // -------------------------------------------------------------------------
  // AC-7 — a read with no owner stays project-only, whatever scope asks
  // -------------------------------------------------------------------------

  it('AC-7: findByProjectMemory with no owner answers no user row, even when scope is user', async () => {
    const note = await post(alice.apiKey, userNote());
    const project = await post(alice.apiKey, projectNote());

    const result = await repository.findByProjectMemory(
      { projectId: world.projectId, scope: 'user' },
      { current: 1, size: 20 },
    );
    const records: MemoryItem[] = result.records;

    expect(records.map((record) => record.id)).not.toContain(note);
    // "Project-only" is the whole answer: the project's own row is still listed.
    expect(records.map((record) => record.id)).toEqual([project]);
    expect(records.every((record) => record.scope === 'project')).toBe(true);
  });

  it('AC-7: the same read with the owner answers that note, so only the owner decides it', async () => {
    const note = await post(alice.apiKey, userNote());
    const project = await post(alice.apiKey, projectNote());

    const result = await repository.findByProjectMemory(
      { projectId: world.projectId, scope: 'user', owner: { ownerType: 'AGENT', ownerId: alice.id } },
      { current: 1, size: 20 },
    );

    expect(result.records.map((record) => record.id)).toEqual([note]);
    expect(result.records.map((record) => record.id)).not.toContain(project);
  });

  it('AC-7: another principal owner answers none of that note', async () => {
    await post(alice.apiKey, userNote());

    const result = await repository.findByProjectMemory(
      { projectId: world.projectId, owner: { ownerType: 'AGENT', ownerId: bob.id } },
      { current: 1, size: 20 },
    );

    expect(result.records).toEqual([]);
  });
});
