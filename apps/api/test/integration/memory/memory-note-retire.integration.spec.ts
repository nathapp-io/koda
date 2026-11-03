/**
 * memory-notes US-011 — `POST /memory/notes/:id/retire`: an approval-gated NOTE retirement.
 *
 * A note is retired through its own route, not through the decision route: `POST /memory/:id/retire` stays
 * decision-only (AC-17 keeps it working, AC-18 proves it still refuses a note). The note route asks for no new
 * permission key — a retirement is a `memory.create` write under its own command variant
 * (`rest:memory.note.retire`), so a project in proposal mode holds it for approval exactly as it holds a create.
 *
 * Three rules shape every case below:
 *   * the target is resolved before the gate — a row the caller may not see, a non-NOTE, an inactive note and a
 *     user note that names no project all answer before an approval request can be opened (AC-4, AC-6, AC-15);
 *   * a user note (US-004) has no project of its own, so the body names the project that authorises its retire
 *     (AC-8..AC-10);
 *   * the row leaves `active` for `rejected` with a null `activeKey`, which is a change the export replays
 *     (AC-2) and which frees the slug for a fresh note (AC-3).
 *
 * Names used here: project P is the seeded `web` project (slug `web`), the `ops` project is P's neighbour;
 * agent A is `alice` and agent B is `bob`, both rostered in P only; `dev` is a developer of P and `root` is the
 * installation admin.
 *
 * Run: cd apps/api && bun run test:db:up &&
 *      KODA_DB_TESTS=1 bunx vitest run test/integration/memory/memory-note-retire.integration.spec.ts
 */
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NathApplication } from '@nathapp/nestjs-app';
import { ModulesContainer } from '@nestjs/core';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { MemoryKind } from '../../../src/common/enums';
import { MemoryWriteGuard } from '../../../src/memory/memory-write.guard';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { collectPermissionDeclarations } from '../../../src/permissions/test-helpers/permission-contract';
import { AssistantToolRegistry } from '../../../src/fleet/assistant/assistant-tool.registry';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import {
  rosterFleetAgent,
  seedFleetHttpAgent,
  seedFleetHttpWorld,
  type FleetHttpWorld,
} from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

/** The memory catalog, so every message asserted below is the shipped one. */
const MEMORY_CATALOG = JSON.parse(
  readFileSync(join(__dirname, '../../../src/i18n/en/memory.json'), 'utf8'),
) as Record<string, unknown>;

const NOT_FOUND = (MEMORY_CATALOG['notFound'] as Record<string, string>)['404'];
const NOT_A_DECISION = (MEMORY_CATALOG['retireNotDecision'] as Record<string, string>)['422'];
const NOT_ACTIVE = (MEMORY_CATALOG['retireNotActive'] as Record<string, string>)['409'];
/** The 400 message of a refused memory write, naming the field it refused (`memory.-2`). */
const invalidField = (field: string): string => (MEMORY_CATALOG['-2'] as string).replace('{field}', field);

/** The pending approval request a 202 carries. */
interface Pending { id: string; permissionKey: string; projectId: string }
/** A settled approval decision. */
interface Settled { status: string }
/** One exported row as the JSON feed carries it. */
interface ExportedItem { id: string; status: string }

const SLUG = 'replay-budget';

/** The project note every case starts from; each case changes what it is about. */
const note = (over: Record<string, unknown> = {}) => ({
  kind: MemoryKind.NOTE,
  subject: SLUG,
  predicate: 'project',
  object: 'Budget stays 2,048 MiB.',
  description: 'replay budget',
  ...over,
});

/** One directly written row, for the cases that need a state the write routes cannot produce. */
interface ItemOverrides {
  projectId?: string | null;
  kind?: string;
  subject?: string;
  predicate?: string;
  status?: string;
  activeKey?: string | null;
  scope?: string;
  ownerId?: string;
  ownerType?: string;
  ownerKey?: string;
  deletedAt?: Date;
}

describeIntegration('memory note retirement: POST /memory/notes/:id/retire (memory-notes US-011)', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let alice: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let bob: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  /**
   * An agent that holds the replace authority (`memory.update`) and project access in P but no `memory.create`:
   * the grant AC-7's fix-round case uses to prove the route enforces both declared keys.
   */
  let replaceOnly: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let serial = 0;

  const server = () => app.getHttpServer();
  const auth = (credential: string) => ({ Authorization: `Bearer ${credential}` });

  /** `POST /memory` in project `projectId` (the seeded `web` project unless a case says otherwise). */
  const postMemory = (credential: string, body: Record<string, unknown>, projectId: string = world.projectId) =>
    request(server()).post('/api/memory').set(auth(credential)).send({ projectId, ...body });
  /** `POST /memory` of the standard note. */
  const postNote = (credential: string, over: Record<string, unknown> = {}) => postMemory(credential, note(over)).expect(201);
  /** `POST /memory/notes/:id/retire`, the route this story adds. */
  const retireNote = (credential: string, id: string, body: Record<string, unknown> = {}) =>
    request(server()).post(`/api/memory/notes/${id}/retire`).set(auth(credential)).send(body);
  /** The decision-only route, which this story must leave alone. */
  const retireDecision = (credential: string, id: string, body: Record<string, unknown> = {}) =>
    request(server()).post(`/api/memory/${id}/retire`).set(auth(credential)).send(body);

  const itemId = (response: request.Response): string => data<{ id: string }>(response).id;
  const row = (id: string) => db.memoryItem.findUniqueOrThrow({ where: { id } });
  const rowsOf = (subject: string) =>
    db.memoryItem.findMany({ where: { projectId: world.projectId, subject }, orderBy: { createdAt: 'asc' } });
  const pendingCount = () => db.approvalRequest.count();

  /** One active row of project P, unless the case names another project or another state. */
  const insertItem = (over: ItemOverrides = {}) => {
    const subject = over.subject ?? `direct-note-${++serial}`;
    return db.memoryItem.create({
      data: {
        projectId: world.projectId,
        kind: MemoryKind.NOTE,
        subject,
        predicate: 'project',
        object: 'Body.',
        description: 'direct note',
        status: 'active',
        activeKey: `NOTE:${subject}`,
        ...over,
      },
    });
  };

  /** The proposal-mode policy: agents' `memory.create` writes in P wait for a human. */
  const holdCreatesForApproval = () => db.approvalPolicy.create({
    data: {
      selector: `${world.projectId}|memory.create|type:AGENT`,
      projectId: world.projectId,
      permissionPattern: 'memory.create',
      principalType: 'AGENT',
      mode: 'human',
      updatedByType: 'SYSTEM',
      updatedById: 'test',
    },
  });

  const pending = (response: request.Response): Pending => {
    expect(response.status).toBe(202);
    return data<Pending>(response);
  };

  const approve = async (id: string): Promise<Settled> => data<Settled>(
    await request(server()).post(`/api/approvals/${id}/decisions`).set(auth(world.tokens.root))
      .send({ decision: 'approve' }).expect(200),
  );

  /** `GET /projects/web/memory/export` — the feed a mirror replays. */
  const exportPage = async (credential: string, query: Record<string, string> = {}) =>
    data<{ items: ExportedItem[]; nextCursor: string | null }>(
      await request(server()).get('/api/projects/web/memory/export').query(query).set(auth(credential)).expect(200),
    );

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    alice = await seedFleetHttpAgent(server(), world.tokens.root);
    bob = await seedFleetHttpAgent(server(), world.tokens.root);
    replaceOnly = await seedFleetHttpAgent(server(), world.tokens.root);
    // Both agents are rostered in P only: the developer role gives each `memory.create` and `memory.update.own`,
    // which is what lets A retire its own rows and refuses B another principal's (AC-7, AC-16).
    await rosterFleetAgent(db, alice.id, world.projectId);
    await rosterFleetAgent(db, bob.id, world.projectId);
    // The third agent gets exactly the two keys its case needs, and not `memory.create`.
    await grantKeys(db, { type: 'AGENT', id: replaceOnly.id }, ['project.read', 'memory.update'], world.projectId);
    await app.get(PermissionCache).invalidate();
  }, 120_000);

  beforeEach(async () => {
    resetThrottle(app);
    // Each case writes the rows it reads, and opens only the approval requests it asserts on.
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
    await db.memoryItem.deleteMany();
  });

  afterAll(async () => {
    await app?.close();
  });

  // -------------------------------------------------------------------------
  // AC-1 — the retire itself
  // -------------------------------------------------------------------------

  it('AC-1: the agent that owns an active project note retires it — 201, rejected, no active key', async () => {
    const created = await postNote(alice.apiKey);
    const id = itemId(created);
    expect(await row(id)).toMatchObject({ status: 'active', activeKey: `NOTE:${SLUG}` });

    const response = await retireNote(alice.apiKey, id).expect(201);

    expect(data<{ id: string; status: string; activeKey?: string | null }>(response))
      .toMatchObject({ id, status: 'rejected' });
    expect(await row(id)).toMatchObject({ status: 'rejected', activeKey: null, subject: SLUG });
  });

  it('AC-1: a user note of the caller is retired by the same route, in the project the body names', async () => {
    // AC-8 in full; AC-1's own shape, so a failure names the right story.
    const created = await postMemory(alice.apiKey, note({ scope: 'user', predicate: 'user' })).expect(201);
    const id = itemId(created);

    await retireNote(alice.apiKey, id, { projectId: world.projectId }).expect(201);

    expect(await row(id)).toMatchObject({ status: 'rejected', activeKey: null, projectId: null, scope: 'user' });
  });

  // -------------------------------------------------------------------------
  // AC-2 — the retirement is a change the export replays
  // -------------------------------------------------------------------------

  it('AC-2: after the settle window, an export from the cursor taken before the retire answers it rejected', async () => {
    // A faked clock, not a wait: `updatedAt` is stamped client-side by the writing transaction, so moving the
    // clock moves the stamp. Only `Date` is faked — the HTTP server, Prisma and the throttler keep real timers.
    // The clock starts at the real one so the session's already-issued token stays inside its lifetime.
    const start = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(start);
      const created = await postNote(alice.apiKey, { subject: `export-${SLUG}` });
      const id = itemId(created);

      // 1. the cursor a mirror holds: the note itself, once it is past the 5000 ms settle window.
      vi.setSystemTime(start + 10_000);
      const before = await exportPage(alice.apiKey);
      expect(before.items.map((item) => item.id)).toEqual([id]);
      const cursor = String(before.nextCursor);
      expect(before.items[0].status).toBe('active');

      // 2. the retire, and the clock stepped past the settle window that would otherwise hold it back.
      vi.setSystemTime(start + 20_000);
      await retireNote(alice.apiKey, id).expect(201);
      vi.setSystemTime(start + 30_000);

      // 3. the same cursor now answers the row again — with the status that makes a mirror forget it.
      const after = await exportPage(alice.apiKey, { since: cursor });

      expect(after.items.map((item) => item.id)).toContain(id);
      expect(after.items.find((item) => item.id === id)).toMatchObject({ status: 'rejected' });
    } finally {
      vi.useRealTimers();
    }
  });

  // -------------------------------------------------------------------------
  // AC-3 — the slug is free again
  // -------------------------------------------------------------------------

  it('AC-3: a note of the retired slug is stored fresh instead of reviving the rejected row', async () => {
    const retired = itemId(await postNote(alice.apiKey));
    await retireNote(alice.apiKey, retired).expect(201);

    const recreated = await postNote(alice.apiKey, { object: 'Budget is now 4,096 MiB.' });
    const fresh = itemId(recreated);

    expect(fresh).not.toBe(retired);
    const rows = await rowsOf(SLUG);
    expect(rows).toHaveLength(2);
    expect(rows.find((one) => one.id === retired)).toMatchObject({ status: 'rejected', activeKey: null });
    expect(rows.find((one) => one.id === fresh)).toMatchObject({
      status: 'active', activeKey: `NOTE:${SLUG}`, object: 'Budget is now 4,096 MiB.',
    });
  });

  // -------------------------------------------------------------------------
  // AC-4 / AC-5 — the two states a retire refuses by the row's own shape
  // -------------------------------------------------------------------------

  it('AC-4: a FACT id answers 422 and is left active', async () => {
    const fact = itemId(await postMemory(alice.apiKey, {
      kind: MemoryKind.FACT, subject: 'budget', predicate: 'stays', object: '2048 MiB',
    }).expect(201));

    const response = await retireNote(alice.apiKey, fact).expect(422);

    expect(response.body.message).toBe(NOT_A_DECISION);
    expect(await row(fact)).toMatchObject({ status: 'active' });
  });

  it('AC-5: a superseded note answers 409 memory.retireNotActive and the replacement stays active', async () => {
    const first = itemId(await postNote(alice.apiKey));
    const second = itemId(await postNote(alice.apiKey, { object: 'Budget is now 4,096 MiB.' }));
    expect(await row(first)).toMatchObject({ status: 'superseded' });

    const response = await retireNote(alice.apiKey, first).expect(409);

    expect(response.body.message).toBe(NOT_ACTIVE);
    expect(await row(first)).toMatchObject({ status: 'superseded', activeKey: null });
    expect(await row(second)).toMatchObject({ status: 'active', activeKey: `NOTE:${SLUG}` });
  });

  // -------------------------------------------------------------------------
  // AC-6 — every target the caller may not see is the same 404
  // -------------------------------------------------------------------------

  it('AC-6: an unknown id, a soft-deleted note and a foreign project note all answer 404 memory.notFound', async () => {
    const unknown = await retireNote(alice.apiKey, 'note-that-never-existed').expect(404);
    expect(unknown.body.message).toBe(NOT_FOUND);

    const deleted = await insertItem({ deletedAt: new Date() });
    expect((await retireNote(alice.apiKey, deleted.id).expect(404)).body.message).toBe(NOT_FOUND);

    // P's neighbour: alice is rostered in `web` only, so a note of `ops` is not hers to see.
    const foreign = await insertItem({ projectId: world.opsProjectId, subject: 'ops-note' });
    expect((await retireNote(alice.apiKey, foreign.id).expect(404)).body.message).toBe(NOT_FOUND);

    expect(await row(deleted.id)).toMatchObject({ status: 'active' });
    expect(await row(foreign.id)).toMatchObject({ status: 'active' });
    expect(await pendingCount()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // AC-7 / AC-16 — another principal's project note needs the any-row replace grant
  // -------------------------------------------------------------------------

  it("AC-7: agent B may not retire agent A's project note — 403, and the row stays active", async () => {
    const created = await postNote(alice.apiKey);
    const id = itemId(created);

    const response = await retireNote(bob.apiKey, id).expect(403);

    // The permission refusal, not the memory validation envelope.
    expect(response.body.ret).toBe(40003);
    expect(await row(id)).toMatchObject({ status: 'active', activeKey: `NOTE:${SLUG}` });
    expect(await db.auditEntry.count({ where: { resourceId: id, key: 'memory.create' } })).toBe(1);
  });

  it('AC-7: a caller holding the any-row replace grant but not memory.create is refused, row active', async () => {
    const created = await postNote(alice.apiKey);
    const id = itemId(created);

    // The replace authority alone: `memory.update` is exactly what `mayReplace` asks, and `memory.create` — the
    // key this route declares next to it — is deliberately absent.
    const response = await retireNote(replaceOnly.apiKey, id).expect(403);

    expect(response.body).toMatchObject({ ret: 40003 });
    expect(await row(id)).toMatchObject({ status: 'active', activeKey: `NOTE:${SLUG}` });
    expect(await pendingCount()).toBe(0);
  });

  it("AC-16: the refusal of another principal's note is MemoryWriteGuard.mayReplace answering 403 permissions", async () => {
    const created = await postNote(alice.apiKey);
    const id = itemId(created);
    const guard = app.get(MemoryWriteGuard);

    // The one answer under test: the guard refuses to replace the row. Everything else about the call is real.
    const spy = vi.spyOn(guard, 'mayReplace').mockResolvedValueOnce(false);
    try {
      const response = await retireNote(alice.apiKey, id).expect(403);

      // The guard was asked about this row, in this project, for this principal — and its refusal is the
      // `permissions` 403, not the not-found one a target that does not exist would get.
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ actorType: 'agent', id: alice.id }),
        world.projectId,
        expect.objectContaining({ id, kind: MemoryKind.NOTE }),
      );
      expect(response.body).toMatchObject({ ret: 40003 });
    } finally {
      spy.mockRestore();
    }

    expect(await row(id)).toMatchObject({ status: 'active', activeKey: `NOTE:${SLUG}` });
  });

  // -------------------------------------------------------------------------
  // AC-8 .. AC-10 — user notes: the caller's own, named in a project
  // -------------------------------------------------------------------------

  it('AC-8: agent A retires its own user note naming a project it is a member of — 201, rejected', async () => {
    const created = await postMemory(alice.apiKey, note({ scope: 'user', predicate: 'user' })).expect(201);
    const id = itemId(created);

    await retireNote(alice.apiKey, id, { projectId: world.projectId }).expect(201);

    expect(await row(id)).toMatchObject({
      status: 'rejected', activeKey: null, projectId: null, scope: 'user', ownerKey: `AGENT:${alice.id}`,
    });
  });

  it("AC-9: agent B retiring agent A's user note answers 404 and leaves it active", async () => {
    const created = await postMemory(alice.apiKey, note({ scope: 'user', predicate: 'user' })).expect(201);
    const id = itemId(created);

    const response = await retireNote(bob.apiKey, id, { projectId: world.projectId }).expect(404);

    // Bob is a member of P, so membership is not what refuses this: ownership is, answered as a missing row.
    expect(response.body.message).toBe(NOT_FOUND);
    expect(await row(id)).toMatchObject({ status: 'active', activeKey: `NOTE:${SLUG}` });
  });

  it('a body projectId is ignored for a project note: the row\'s own project authorises and audits it', async () => {
    const created = await postNote(alice.apiKey);
    const id = itemId(created);

    // `ops` is a project alice is NOT a member of. A project note ignores the body, so this is the note's own
    // project doing the authorising — the same retire a member of P always gets.
    await retireNote(alice.apiKey, id, { projectId: world.opsProjectId }).expect(201);

    expect(await row(id)).toMatchObject({ status: 'rejected' });
    const entries = await db.auditEntry.findMany({ where: { resourceId: id, summary: 'retired NOTE' } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ key: 'memory.create', projectId: world.projectId });
  });

  it('AC-10: a user note without projectId answers 400 naming projectId, and a foreign project answers 404', async () => {
    const created = await postMemory(alice.apiKey, note({ scope: 'user', predicate: 'user' })).expect(201);
    const id = itemId(created);

    const unnamed = await retireNote(alice.apiKey, id).expect(400);
    expect(unnamed.body).toMatchObject({ ret: -2, message: invalidField('projectId') });

    // `ops`: alice is not rostered there, so the named project cannot authorise her own note's retire.
    const foreign = await retireNote(alice.apiKey, id, { projectId: world.opsProjectId }).expect(404);
    expect(foreign.body.message).toBe(NOT_FOUND);

    expect(await row(id)).toMatchObject({ status: 'active' });
    expect(await pendingCount()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // AC-11 / AC-15 — a bad target never opens an approval request
  // -------------------------------------------------------------------------

  it('AC-11: under a human policy an agent retires a FACT with 422 and opens no approval request', async () => {
    // The FACT is written before the policy exists, so this case starts from a stored row and no request.
    const fact = itemId(await postMemory(alice.apiKey, {
      kind: MemoryKind.FACT, subject: 'gated-fact', predicate: 'stays', object: '2048 MiB',
    }).expect(201));
    await holdCreatesForApproval();
    expect(await pendingCount()).toBe(0);

    const response = await retireNote(alice.apiKey, fact).expect(422);

    expect(response.body.message).toBe(NOT_A_DECISION);
    expect(await row(fact)).toMatchObject({ status: 'active' });
    expect(await pendingCount()).toBe(0);
  });

  it('AC-15: under a human policy an inactive note answers 409 before the gate and opens no request', async () => {
    const superseded = await insertItem({ subject: 'gated-inactive', status: 'superseded', activeKey: null });
    await holdCreatesForApproval();

    const response = await retireNote(alice.apiKey, superseded.id).expect(409);

    expect(response.body.message).toBe(NOT_ACTIVE);
    expect(await pendingCount()).toBe(0);
    expect(await row(superseded.id)).toMatchObject({ status: 'superseded' });
  });

  // -------------------------------------------------------------------------
  // AC-12 — a proposal-mode project holds the retire for approval
  // -------------------------------------------------------------------------

  it('AC-12: a human memory.create policy holds an agent note retire for approval, which then retires it', async () => {
    const created = await postNote(alice.apiKey);
    const id = itemId(created);
    await holdCreatesForApproval();

    const summary = pending(await retireNote(alice.apiKey, id, { reason: 'stale' }));

    // The request is the `memory.create` one: the note route asks for no key of its own.
    expect(summary).toMatchObject({ permissionKey: 'memory.create', projectId: world.projectId });
    expect(summary.id).toEqual(expect.any(String));
    expect(await row(id)).toMatchObject({ status: 'active', activeKey: `NOTE:${SLUG}` });

    expect(await approve(summary.id)).toMatchObject({ status: 'executed' });

    expect(await row(id)).toMatchObject({ status: 'rejected', activeKey: null });
  });

  it('an approved retire that lost its target to a supersede fails and leaves the replacement active', async () => {
    const created = await postNote(alice.apiKey);
    const id = itemId(created);
    const policy = await holdCreatesForApproval();
    const summary = pending(await retireNote(alice.apiKey, id));
    expect(await row(id)).toMatchObject({ status: 'active' });

    // The note is replaced while the ask is still pending. The policy is dropped first so the replacement is a
    // real supersede instead of a second ask — what changes is the row, not the requester's grants.
    await db.approvalPolicy.delete({ where: { id: policy.id } });
    const replacement = itemId(await postNote(alice.apiKey, { object: 'Budget is now 4,096 MiB.' }));
    expect(await row(id)).toMatchObject({ status: 'superseded' });

    // The deferred execution re-runs the resolution inside the lock, so it refuses with memory.retireNotActive.
    expect(await approve(summary.id)).toMatchObject({ status: 'failed', result: { error: 'execution-failed' } });

    expect(await row(id)).toMatchObject({ status: 'superseded', activeKey: null });
    expect(await row(replacement)).toMatchObject({ status: 'active', activeKey: `NOTE:${SLUG}` });
  });

  // -------------------------------------------------------------------------
  // AC-13 — the audit entry a retirement records
  // -------------------------------------------------------------------------

  it('AC-13: a retire with a reason records one memory.create entry naming the note and the reason', async () => {
    // Written directly, so the retirement is the only entry naming this row.
    const target = await insertItem({ subject: 'audited-note', ownerType: 'AGENT', ownerId: alice.id });

    await retireNote(alice.apiKey, target.id, { reason: 'stale' }).expect(201);

    const entries = await db.auditEntry.findMany({ where: { resourceId: target.id } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      key: 'memory.create',
      resourceType: 'memory-item',
      resourceId: target.id,
      projectId: world.projectId,
      summary: 'retired NOTE: stale',
    });
  });

  // -------------------------------------------------------------------------
  // AC-17 / AC-18 — the decision route is untouched
  // -------------------------------------------------------------------------

  it('AC-17: POST /memory/:id/retire still retires a DECISION for an authorized owner', async () => {
    const target = await insertItem({
      kind: MemoryKind.DECISION, subject: 'repo:acme/app', predicate: 'finding-1',
      activeKey: 'DECISION:repo:acme/app:finding-1', ownerType: 'USER', ownerId: world.ids.dev,
    });

    const response = await retireDecision(world.tokens.dev, target.id).expect(201);

    expect(data<{ id: string; status: string }>(response)).toMatchObject({ id: target.id, status: 'rejected' });
    expect(await row(target.id)).toMatchObject({ status: 'rejected', activeKey: null });
  });

  it('AC-18: POST /memory/:id/retire still refuses a NOTE — 422, and the note stays active', async () => {
    const target = await insertItem({ subject: 'not-a-decision' });

    const response = await retireDecision(world.tokens.root, target.id).expect(422);

    expect(response.body.message).toBe(NOT_A_DECISION);
    expect(await row(target.id)).toMatchObject({ status: 'active', activeKey: 'NOTE:not-a-decision' });
  });

  // -------------------------------------------------------------------------
  // The route's declaration, read off the booted app
  // -------------------------------------------------------------------------

  it('declares the note retire route as an approval-gated memory.create write', () => {
    const declarations = collectPermissionDeclarations(app.get(ModulesContainer), app.get(AssistantToolRegistry));

    expect(declarations.routes.find((route) => route.route === 'POST /memory/notes/:id/retire'))
      .toMatchObject({ gated: true, requires: { keys: ['memory.create', 'memory.update'] } });
    // The decision route keeps its own declaration: two routes, one key, no shared handler.
    expect(declarations.routes.find((route) => route.route === 'POST /memory/:id/retire'))
      .toMatchObject({ gated: true, requires: { keys: ['memory.decision.retire'] } });
  });
});
