import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Permissions P2 US-002 — every memory route write records exactly one audit entry, in the upsert's own
 * transaction (review findings C/SEC-1 and C/SEC-2).
 *
 * The entries are read back from `AuditEntry`, over real HTTP, real Postgres and the real recorder: no
 * assertion below goes through a stub. The two cases that make the audit fail spy on the application's
 * own `AuditRecorder.record`, so the rejection happens where production's does — inside `upsert`'s
 * serializable transaction — and what the database holds afterwards is the rollback's answer.
 *
 * Run: cd apps/api && bun run test:db:up &&
 *      bun run test:scoped test/integration/audit/audit-memory-routes.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { grantBaseline, grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { fixtureDb } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

const SLUG = 'mem-audit';
/** `CreateProjectDto.key` is `^[A-Z]{2,6}$` — letters only. */
const PROJECT_KEY = 'MAU';
const BOOT_TIMEOUT = 120_000;
const TIMEOUT = 30_000;

describeIntegration('US-002 audited memory routes', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let audit: AuditRecorder;
  let projectId: string;
  let ticketId: string;
  let rootToken: string;
  let devToken: string;
  let devId: string;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** Every audit entry of one key that names one resource. */
  const entries = (key: string, resourceId: string) => db.auditEntry.findMany({ where: { key, resourceId } });

  /** `POST /memory` in this file's project: a FACT of the `owner` predicate unless the body says otherwise. */
  const postFact = (token: string, body: Record<string, unknown>) =>
    request(server).post('/api/memory').set(auth(token)).send({ projectId, kind: 'FACT', ...body });

  /** The fact body the story names: one subject, the `owner` predicate, one source. */
  const factBody = (subject: string, object: string) =>
    ({ subject, predicate: 'owner', object, sourceId: 'note-1' });

  /** The created item's id, as the route answers it (the handler returns the item, unwrapped). */
  const itemIdOf = (response: request.Response): string => {
    const body = response.body as { id?: unknown };
    expect(typeof body.id).toBe('string');
    return String(body.id);
  };

  /** One memory row as the database holds it, narrowed to what these cases assert. */
  interface FactRow { id: string; status: string; object: string | null }

  /** The FACT rows of one subject/predicate key, any status, newest first. */
  const factRows = (subject: string): Promise<FactRow[]> => db.memoryItem.findMany({
    where: { projectId, kind: 'FACT', subject, predicate: 'owner' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, object: true },
  });

  const activeFact = async (subject: string): Promise<FactRow | undefined> =>
    (await factRows(subject)).find((row) => row.status === 'active');

  /** Refuse one audit key for the rest of the case; the recorder is the application's own. */
  const failAuditFor = (key: string) => vi.spyOn(audit, 'record').mockImplementation(async (input) => {
    if (input.key === key) throw new Error('audit down');
  });

  beforeAll(async () => {
    const previous = process.env['EMBEDDING_PROVIDER'];
    process.env['EMBEDDING_PROVIDER'] = 'fake';
    try {
      await resetDb();
      app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    } finally {
      if (previous === undefined) delete process.env['EMBEDDING_PROVIDER'];
      else process.env['EMBEDDING_PROVIDER'] = previous;
    }
    server = app.getHttpServer();
    db = fixtureDb(app);
    audit = app.get(AuditRecorder);

    const root = await request(server).post('/api/auth/register')
      .send({ email: 'mem-root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    rootToken = data<{ accessToken: string }>(root).accessToken;
    const rootId = (await db.user.findUniqueOrThrow({ where: { email: 'mem-root@koda.test' } })).id;
    await grantBaseline(db, { type: 'USER', id: rootId });

    const project = await request(server).post('/api/projects').set(auth(rootToken))
      .send({ name: 'Memory Audit', slug: SLUG, key: PROJECT_KEY }).expect(201);
    projectId = data<{ id: string }>(project).id;

    const created = await request(server).post('/api/admin/users').set(auth(rootToken))
      .send({ email: 'mem-dev@koda.test', name: 'Dev', password: TEST_PASSWORD }).expect(201);
    devId = data<{ id: string }>(created).id;
    // The developer role is the one principal that writes memory but replaces only its own items.
    await grantBaseline(db, { type: 'USER', id: devId });
    await grantRole(db, { type: 'USER', id: devId }, 'developer', projectId);
    devToken = await loginToken(server, 'mem-dev@koda.test');

    ticketId = (await db.ticket.create({ data: {
      projectId, number: 1, type: 'BUG', status: 'CREATED', priority: 'MEDIUM', title: 'Memory audited ticket',
    } })).id;
  }, BOOT_TIMEOUT);

  afterAll(async () => { await app?.close(); });
  beforeEach(() => resetThrottle(app));

  // -------------------------------------------------------------------------
  // AC-1 / AC-2 / AC-3 — the create route's entry and what it never says
  // -------------------------------------------------------------------------

  it('AC-1/2: a fact POST answers 201 and records one memory.create entry for the new item', async () => {
    const response = await postFact(devToken, factBody('svc', 'Private fact')).expect(201);

    const rows = await entries('memory.create', itemIdOf(response));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: 'memory.create',
      resourceType: 'memory-item',
      projectId,
      actorType: 'USER',
      actorId: devId,
      origin: 'rest',
      summary: 'created FACT',
    });
  }, TIMEOUT);

  it('AC-3: the entry names neither the subject, the predicate nor the object', async () => {
    const response = await postFact(devToken, factBody('svc-p', 'Private fact')).expect(201);

    const [entry] = await entries('memory.create', itemIdOf(response));
    expect(entry?.summary).toBe('created FACT');
    for (const secret of ['svc-p', 'owner', 'Private fact']) expect(entry?.summary).not.toContain(secret);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-4 / AC-5 — the identical restatement writes, and records, nothing
  // -------------------------------------------------------------------------

  it('AC-4/5: an identical repeat answers the same item and records no second entry', async () => {
    const first = await postFact(devToken, factBody('svc-r', 'Private fact')).expect(201);
    const repeat = await postFact(devToken, factBody('svc-r', 'Private fact')).expect(201);

    const itemId = itemIdOf(first);
    expect(itemIdOf(repeat)).toBe(itemId);
    expect(await entries('memory.create', itemId)).toHaveLength(1);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-6 — a replacement is the entry point's entry, and names the id it replaced
  // -------------------------------------------------------------------------

  it('AC-6: a replacement records one entry whose summary names the superseded item', async () => {
    const first = await postFact(devToken, factBody('svc-s', 'v1')).expect(201);
    const replacement = await postFact(devToken, factBody('svc-s', 'v2')).expect(201);

    const supersededId = itemIdOf(first);
    const replacementId = itemIdOf(replacement);
    expect(replacementId).not.toBe(supersededId);

    const rows = await entries('memory.create', replacementId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.summary).toBe(`created FACT, superseded ${supersededId}`);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-7 / AC-8 / AC-26 — a refused replacement writes nothing and records nothing
  // -------------------------------------------------------------------------

  it('AC-7/8/26: a refused replacement answers 403, leaves the item active and records no entry', async () => {
    await postFact(rootToken, factBody('svc2', 'root value')).expect(201);
    const owned = await activeFact('svc2');
    expect(owned).toMatchObject({ object: 'root value', status: 'active' });
    const before = await db.auditEntry.count({ where: { key: 'memory.create', projectId } });

    const refused = await postFact(devToken, factBody('svc2', 'dev value'));
    expect(refused.status).toBe(403);

    expect(await db.auditEntry.count({ where: { key: 'memory.create', projectId } })).toBe(before);
    // The refusal is the guard's, inside the transaction: the row it would have replaced is untouched.
    expect(await activeFact('svc2')).toEqual(owned);
    expect(await factRows('svc2')).toHaveLength(1);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-9 / AC-10 / AC-11 — a refused audit entry rolls the whole write back
  // -------------------------------------------------------------------------

  it('AC-9/10/11: a rejected memory.create entry rolls back the new item and the supersede', async () => {
    await postFact(devToken, factBody('svc3', 'v1')).expect(201);
    const original = await activeFact('svc3');
    expect(original).toMatchObject({ object: 'v1', status: 'active' });

    const spy = failAuditFor('memory.create');
    try {
      const failed = await postFact(devToken, factBody('svc3', 'v2'));
      expect(failed.status).toBeGreaterThanOrEqual(400);
    } finally {
      spy.mockRestore();
    }

    expect(await db.memoryItem.count({ where: { projectId, subject: 'svc3', predicate: 'owner', object: 'v2' } })).toBe(0);
    expect(await activeFact('svc3')).toEqual(original);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-12 / AC-13 — the extract route records one entry per item it writes
  // -------------------------------------------------------------------------

  it('AC-12/13: an extraction records one memory.extract entry per row it wrote', async () => {
    await request(server).post('/api/memory/extract').set(auth(devToken)).send({
      projectId,
      type: 'ticket_event',
      id: 'evt-1',
      ticketId,
      action: 'status_changed',
      data: { newStatus: 'IN_PROGRESS' },
    }).expect(201);

    const rows = await db.memoryItem.findMany({ where: { projectId, sourceId: 'evt-1' }, select: { id: true } });
    expect(rows.length).toBeGreaterThanOrEqual(1);

    for (const row of rows) {
      const written = await entries('memory.extract', row.id);
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({
        key: 'memory.extract', resourceType: 'memory-item', actorId: devId, projectId, summary: 'created FACT',
      });
    }
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-16 / AC-17 / AC-18 — the decisions route records its own key
  // -------------------------------------------------------------------------

  it('AC-16/17: a decision records one memory.decision.record entry with a content-free summary', async () => {
    const response = await request(server).post('/api/memory/decisions').set(auth(devToken))
      .send({ projectId, topic: 'Private topic', decision: 'Private decision' }).expect(201);

    const memoryId = (response.body as { memoryId: string }).memoryId;
    const rows = await entries('memory.decision.record', memoryId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: 'memory.decision.record', resourceType: 'memory-item', actorId: devId, projectId, summary: 'created DECISION',
    });
    for (const secret of ['Private topic', 'Private decision']) expect(rows[0]?.summary).not.toContain(secret);
  }, TIMEOUT);

  it('AC-18: a second decision on the same topic names the decision it superseded', async () => {
    const first = await request(server).post('/api/memory/decisions').set(auth(devToken))
      .send({ projectId, topic: 't2', decision: 'First' }).expect(201);
    const second = await request(server).post('/api/memory/decisions').set(auth(devToken))
      .send({ projectId, topic: 't2', decision: 'Second' }).expect(201);

    const firstId = (first.body as { memoryId: string }).memoryId;
    const secondId = (second.body as { memoryId: string }).memoryId;
    const rows = await entries('memory.decision.record', secondId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.summary).toBe(`created DECISION, superseded ${firstId}`);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-19 / AC-20 — a refused decision entry writes no decision at all
  // -------------------------------------------------------------------------

  it('AC-19/20: a rejected memory.decision.record entry leaves no decision behind', async () => {
    const spy = failAuditFor('memory.decision.record');
    try {
      const failed = await request(server).post('/api/memory/decisions').set(auth(devToken))
        .send({ projectId, topic: 'atomic', decision: 'Never stored' });
      expect(failed.status).toBeGreaterThanOrEqual(400);
    } finally {
      spy.mockRestore();
    }

    expect(await db.memoryItem.count({ where: { projectId, kind: 'DECISION', predicate: 'atomic' } })).toBe(0);
  }, TIMEOUT);
});
