/**
 * memory-notes US-004 — writing a principal-owned, user-scoped note.
 *
 * `scope: 'user'` is accepted only for `kind: 'NOTE'`. The request still names a `projectId`: membership,
 * `memory.create` and the approval policy are all checked against it exactly as for a project write, so a
 * project in proposal mode also holds a user note for approval. The stored row has `projectId: null`,
 * `scope: 'user'`, the caller as its owner (a body `ownerId` is ignored, even for a global admin) and
 * `ownerKey` = `<ownerType>:<ownerId>`, which is what `@@unique([ownerKey, activeKey])` keys it on while
 * `@@unique([projectId, activeKey])` keeps keying project rows.
 *
 * Run: cd apps/api && bun run test:db:up &&
 *      KODA_DB_TESTS=1 bunx vitest run test/integration/memory/memory-user-scope-write.integration.spec.ts
 */
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NathApplication } from '@nathapp/nestjs-app';
import { MemoryKind } from '../../../src/common/enums';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, rosterFleetAgent, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

const MEMORY_CATALOG = JSON.parse(
  readFileSync(join(__dirname, '../../../src/i18n/en/memory.json'), 'utf8'),
) as Record<string, string | Record<string, string>>;

/** The 400 message for a refused memory write, naming the field it refused (`memory.-2`). */
const invalidField = (field: string): string => (MEMORY_CATALOG['-2'] as string).replace('{field}', field);
/** The 404 sentence of `memory.notFound`. */
const NOT_FOUND = (MEMORY_CATALOG['notFound'] as Record<string, string>)['404'];

interface Pending { id: string; permissionKey: string; projectId: string }
interface Settled { status: string }

/** The note every user-scope case writes; each case changes what it is about. */
const userNote = (over: Record<string, unknown> = {}) => ({
  scope: 'user',
  kind: MemoryKind.NOTE,
  subject: 'working-style',
  predicate: 'user',
  object: 'Prefers small commits with a test each.',
  description: 'small commits',
  ...over,
});

/** The project-scope note of the same slug, sharing the active key of AC-9's user note. */
const projectNote = () => ({
  kind: MemoryKind.NOTE,
  subject: 'working-style',
  predicate: 'project',
  object: 'This project reviews on Fridays.',
  description: 'friday reviews',
});

describeIntegration('memory user scope: POST /memory with scope user (memory-notes US-004)', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let alice: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let bob: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let stranger: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  const server = () => app.getHttpServer();
  const auth = (credential: string) => ({ Authorization: `Bearer ${credential}` });
  /** `POST /memory` in project `projectId` (the seeded `web` project unless a case says otherwise). */
  const post = (credential: string, body: Record<string, unknown>, projectId: string = world.projectId) =>
    request(server()).post('/api/memory').set(auth(credential)).send({ projectId, ...body });
  const retire = (id: string) => request(server()).post(`/api/memory/${id}/retire`).set(auth(world.tokens.root)).send({});
  const pending = (response: request.Response): Pending => {
    expect(response.status).toBe(202);
    return data<Pending>(response);
  };
  const approve = async (id: string): Promise<Settled> => data<Settled>(
    await request(server()).post(`/api/approvals/${id}/decisions`).set(auth(world.tokens.root))
      .send({ decision: 'approve' }).expect(200),
  );
  const rowsOf = (ownerKey: string) =>
    db.memoryItem.findMany({ where: { ownerKey }, orderBy: { createdAt: 'asc' } });
  const itemId = (response: request.Response): string => data<{ id: string }>(response).id;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    alice = await seedFleetHttpAgent(server(), world.tokens.root);
    bob = await seedFleetHttpAgent(server(), world.tokens.root);
    stranger = await seedFleetHttpAgent(server(), world.tokens.root);
    // Alice writes in both projects (AC-7 moves her note from one to the other); Bob only in `web`; the
    // stranger is in neither, which is what AC-4 needs. A rostered agent holds the developer role, so it
    // replaces its own items (`memory.update.own`) — which is what lets Alice supersede her own note from
    // another project — but nobody else's.
    await rosterFleetAgent(db, alice.id, world.projectId);
    await rosterFleetAgent(db, alice.id, world.opsProjectId);
    await rosterFleetAgent(db, bob.id, world.projectId);
    await app.get(PermissionCache).invalidate();
  }, 120000);

  beforeEach(async () => {
    resetThrottle(app);
    // Each case writes the rows it reads: the note slug below is the same in every case on purpose.
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
    await db.memoryItem.deleteMany();
  });

  afterAll(async () => {
    await app?.close();
  });

  // -------------------------------------------------------------------------
  // AC-2 — the stored row: no project, the caller as owner, a derived ownerKey
  // -------------------------------------------------------------------------

  it('AC-2: an agent member stores a user note with a null project and its own ownerKey', async () => {
    const response = await post(alice.apiKey, userNote()).expect(201);

    const row = await db.memoryItem.findUniqueOrThrow({ where: { id: itemId(response) } });
    expect(row).toMatchObject({
      projectId: null,
      scope: 'user',
      kind: 'NOTE',
      subject: 'working-style',
      predicate: 'user',
      object: 'Prefers small commits with a test each.',
      description: 'small commits',
      status: 'active',
      activeKey: 'NOTE:working-style',
      ownerType: 'AGENT',
      ownerId: alice.id,
      ownerKey: `AGENT:${alice.id}`,
    });
  });

  // -------------------------------------------------------------------------
  // AC-3 / AC-13 — user scope is NOTE-only
  // -------------------------------------------------------------------------

  it('AC-3: scope user on a FACT answers 400 naming scope and writes nothing', async () => {
    const response = await post(alice.apiKey, {
      scope: 'user', kind: MemoryKind.FACT, subject: 'budget', predicate: 'stays', object: '2048 MiB',
    }).expect(400);

    expect(response.body).toMatchObject({ ret: -2, message: invalidField('scope') });
    expect(await db.memoryItem.count()).toBe(0);
  });

  it.each([MemoryKind.DECISION, MemoryKind.PREFERENCE, MemoryKind.CONSTRAINT, MemoryKind.INCIDENT_PATTERN])(
    'AC-13: scope user on a %s answers 400 naming scope and writes nothing',
    async (kind) => {
      const response = await post(alice.apiKey, {
        scope: 'user', kind, subject: 'working-style', predicate: 'stays', object: 'body',
      }).expect(400);

      expect(response.body).toMatchObject({ ret: -2, message: invalidField('scope') });
      expect(await db.memoryItem.count()).toBe(0);
    },
  );

  // -------------------------------------------------------------------------
  // AC-4 — membership of the named project is still what authorises the write
  //
  // A lone "a non-member is refused" case cannot tell a user-scope request that reached the
  // membership gate from a request whose `scope` the route ignored: the membership refusal comes
  // first either way. The case is therefore paired — the SAME agent credential that a project grant
  // makes a member is accepted, and the same body from the same agent before that grant is refused —
  // so the control below only holds when the scope was accepted as a user note, and the refusal only
  // holds when the write is what the project grant authorises.
  // -------------------------------------------------------------------------

  it('AC-4: a user-scope write is refused for a non-member although the same body stores for a member', async () => {
    // Control: the identical body from an agent that IS a member of the named project is accepted, and it
    // stores the user row the scope asks for — no project, the caller as owner. If `scope` were ignored or
    // stripped, this row would carry the project and this assertion would fail.
    const stored = await post(alice.apiKey, userNote()).expect(201);
    const storedId = itemId(stored);
    expect(await db.memoryItem.findUniqueOrThrow({ where: { id: storedId } })).toMatchObject({
      projectId: null,
      scope: 'user',
      ownerKey: `AGENT:${alice.id}`,
      status: 'active',
    });

    // The refusal: the stranger is a live agent holding no grant in the named project. It sends the same
    // body, so nothing but membership can distinguish the two requests.
    const refused = await post(stranger.apiKey, userNote({ object: 'Prefers no tests at all.' })).expect(403);

    // The permission refusal, not the memory validation envelope (`ret: -2`) a refused scope answers.
    expect(refused.body.ret).toBe(40003);
    // Nothing was written for the stranger — and the member's note was not superseded by the attempt.
    expect(await db.memoryItem.count()).toBe(1);
    expect(await db.memoryItem.findUniqueOrThrow({ where: { id: storedId } })).toMatchObject({
      status: 'active',
      object: 'Prefers small commits with a test each.',
    });
  });

  // -------------------------------------------------------------------------
  // AC-5 — a user-scope note is always owned by its writer
  // -------------------------------------------------------------------------

  it('AC-5: a global admin naming another owner stores the row as itself', async () => {
    const response = await post(world.tokens.root, userNote({ ownerId: world.ids.dev })).expect(201);

    expect(await db.memoryItem.findUniqueOrThrow({ where: { id: itemId(response) } })).toMatchObject({
      ownerType: 'USER',
      ownerId: world.ids.root,
      ownerKey: `USER:${world.ids.root}`,
    });
  });

  // -------------------------------------------------------------------------
  // AC-6 — a write without a scope is the project write it always was
  // -------------------------------------------------------------------------

  it('AC-6: a write without scope stores a project row of the request project with no ownerKey', async () => {
    const response = await post(world.tokens.dev, {
      kind: MemoryKind.FACT, subject: 'budget', predicate: 'stays', object: '2048 MiB',
    }).expect(201);

    expect(await db.memoryItem.findUniqueOrThrow({ where: { id: itemId(response) } })).toMatchObject({
      projectId: world.projectId,
      scope: 'project',
      ownerKey: null,
    });
  });

  // -------------------------------------------------------------------------
  // AC-7 — a user note is one row per principal, whichever project wrote it
  // -------------------------------------------------------------------------

  it('AC-7: the same user note written through another project supersedes the first row', async () => {
    const first = await post(alice.apiKey, userNote()).expect(201);
    const second = await post(alice.apiKey, userNote({ object: 'Prefers one commit per ticket.' }), world.opsProjectId).expect(201);

    const rows = await rowsOf(`AGENT:${alice.id}`);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === itemId(first))).toMatchObject({ projectId: null, status: 'superseded', activeKey: null });
    expect(rows.find((row) => row.id === itemId(second))).toMatchObject({
      projectId: null,
      status: 'active',
      activeKey: 'NOTE:working-style',
      object: 'Prefers one commit per ticket.',
    });
  });

  // -------------------------------------------------------------------------
  // AC-8 — two principals writing the same slug do not collide
  // -------------------------------------------------------------------------

  it('AC-8: two agents writing the same user note keep both rows active', async () => {
    await post(alice.apiKey, userNote()).expect(201);
    await post(bob.apiKey, userNote({ object: 'Prefers squashed merges.' })).expect(201);

    expect(await rowsOf(`AGENT:${alice.id}`)).toMatchObject([{ projectId: null, status: 'active', activeKey: 'NOTE:working-style' }]);
    expect(await rowsOf(`AGENT:${bob.id}`)).toMatchObject([{ projectId: null, status: 'active', activeKey: 'NOTE:working-style' }]);
  });

  // -------------------------------------------------------------------------
  // AC-9 — a user row and a project row of the same slug live side by side
  // -------------------------------------------------------------------------

  it('AC-9: an agent keeps its user note and the project note of the same slug active', async () => {
    const user = await post(alice.apiKey, userNote()).expect(201);
    const project = await post(alice.apiKey, projectNote()).expect(201);

    const rows = await db.memoryItem.findMany({ where: { subject: 'working-style', activeKey: 'NOTE:working-style' } });
    expect(rows.map((row) => row.id).sort()).toEqual([itemId(user), itemId(project)].sort());
    expect(rows.find((row) => row.id === itemId(user))).toMatchObject({ projectId: null, ownerKey: `AGENT:${alice.id}`, status: 'active' });
    expect(rows.find((row) => row.id === itemId(project))).toMatchObject({ projectId: world.projectId, ownerKey: null, status: 'active' });
  });

  // -------------------------------------------------------------------------
  // AC-10 — a project in proposal mode holds the user note for approval too
  // -------------------------------------------------------------------------

  it('AC-10: a human policy on memory.create holds an agent user note for approval, which then stores it', async () => {
    await db.approvalPolicy.create({
      data: {
        selector: `${world.projectId}|memory.create|type:AGENT`, projectId: world.projectId,
        permissionPattern: 'memory.create', principalType: 'AGENT', mode: 'human',
        updatedByType: 'SYSTEM', updatedById: 'test',
      },
    });

    const summary = pending(await post(alice.apiKey, userNote()));
    expect(summary).toMatchObject({ permissionKey: 'memory.create', projectId: world.projectId });
    expect(await db.memoryItem.count()).toBe(0);

    expect(await approve(summary.id)).toMatchObject({ status: 'executed' });

    const rows = await db.memoryItem.findMany({ where: { ownerKey: `AGENT:${alice.id}` } });
    expect(rows).toMatchObject([{ projectId: null, scope: 'user', ownerId: alice.id, ownerType: 'AGENT', status: 'active' }]);
  });

  // -------------------------------------------------------------------------
  // AC-11 — the decision retire route never reaches a user row
  // -------------------------------------------------------------------------

  it('AC-11: retiring a user note answers 404 memory.notFound and leaves it active', async () => {
    const created = await post(world.tokens.dev, userNote()).expect(201);

    const response = await retire(itemId(created)).expect(404);

    expect(response.body.message).toBe(NOT_FOUND);
    expect(await db.memoryItem.findUniqueOrThrow({ where: { id: itemId(created) } })).toMatchObject({ status: 'active' });
  });

  // -------------------------------------------------------------------------
  // AC-12 — the audit entry falls back to the request's project
  // -------------------------------------------------------------------------

  it('AC-12: a user-scope write records one memory.create entry naming the request project', async () => {
    const response = await post(world.tokens.dev, userNote()).expect(201);
    const id = itemId(response);

    // The entry's project is the request's: a user row has none of its own (AC-2).
    expect(await db.memoryItem.findUniqueOrThrow({ where: { id } })).toMatchObject({ projectId: null, scope: 'user' });
    const entries = await db.auditEntry.findMany({ where: { key: 'memory.create', resourceId: id } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      key: 'memory.create',
      resourceType: 'memory-item',
      resourceId: id,
      projectId: world.projectId,
      summary: 'created NOTE',
    });
  });
});
