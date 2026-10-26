import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Permissions P2 US-003 — the memory tools, the outbox extraction and the governance run each record one
 * entry, with the ambient actor and origin of the write they made (spec AC1 .. AC8).
 *
 * Nothing below is a stub: the app boots the real `AppModule` (so the real tool registry, executor, fan-out
 * publisher, governance processor and recorder), the MCP calls go over real HTTP through `POST /api/mcp`,
 * the outbox records go through the application's own `FanOutPublisher`, and both the entries and the memory
 * rows are read back from Postgres. The cases that make the audit fail spy on the application's own
 * `AuditRecorder.record`, so the rejection happens where production's does — inside `upsert`'s serializable
 * transaction for a memory write, and after the cleanup resolved for a governance run — and what the
 * database holds afterwards is the rollback's answer.
 *
 * Run: cd apps/api && bun run test:db:up &&
 *      bun run test:scoped test/integration/audit/audit-memory-system.integration.spec.ts
 */
import request from 'supertest';
import type { OutboxRecord } from '@nathapp/nestjs-outbox';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { FanOutPublisher } from '../../../src/outbox/fan-out-publisher';
import { MemoryGovernanceProcessor } from '../../../src/memory/memory-governance.processor';
import { grantBaseline, grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { outboxRecord } from '../../helpers/outbox-record';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

const SLUG = 'mem-sys';
/** `CreateProjectDto.key` is `^[A-Z]{2,6}$` — letters only. */
const PROJECT_KEY = 'MSY';
const BOOT_TIMEOUT = 120_000;
const TIMEOUT = 30_000;
const ACCEPT = 'application/json, text/event-stream';
const EXTRACT_KEY = 'system.memory.extract-from-event';
const GOVERN_KEY = 'system.memory.govern';

/** What `tools/call` answers: the tool's text and whether it failed, or the executor's own refusal. */
interface ToolAnswer {
  isError: boolean;
  content: Array<{ type: 'text'; text: string }>;
}

interface RpcAnswer {
  result?: ToolAnswer & Record<string, unknown>;
  error?: { code: number; message: string };
}

describeIntegration('US-003 audited memory tools, outbox extraction and governance', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let audit: AuditRecorder;
  let publisher: FanOutPublisher;
  let governance: MemoryGovernanceProcessor;

  let projectId = '';
  let rootToken = '';
  let rootId = '';
  let agentId = '';
  let agentKey = '';
  let ticketNumber = 0;
  let savedMcp: string | undefined;

  const asRoot = (): { Authorization: string } => ({ Authorization: `Bearer ${rootToken}` });

  /** One JSON-RPC request as the developer agent; a 2025-era client is answered as one SSE event. */
  const rpc = async (method: string, params: Record<string, unknown> = {}): Promise<RpcAnswer> => {
    const res = await request(server).post('/api/mcp').set('Accept', ACCEPT)
      .set({ Authorization: `Bearer ${agentKey}` })
      .send({ jsonrpc: '2.0', id: 1, method, params })
      .expect(200);
    const dataLine = res.text.split('\n').find((line) => line.startsWith('data:')) ?? '';
    return String(res.headers['content-type']).includes('text/event-stream')
      ? JSON.parse(dataLine.slice(5))
      : (res.body as RpcAnswer);
  };

  /** One `tools/call` through MCP, as the developer agent. */
  const callTool = async (name: string, args: Record<string, unknown>): Promise<ToolAnswer> => {
    resetThrottle(app);
    const answer = await rpc('tools/call', { name, arguments: args });
    if (answer.result === undefined) throw new Error(`tools/call ${name} answered ${JSON.stringify(answer.error)}`);
    return answer.result;
  };

  /** The single text a tool answered, joined the way a client reads `content`. */
  const textOf = (answer: ToolAnswer): string => answer.content.map((part) => part.text).join('\n');

  /** Every audit entry of one key that names one resource. */
  const entries = (key: string, resourceId: string) => db.auditEntry.findMany({ where: { key, resourceId } });

  /** A live ticket of this file's project, numbered in this file. */
  const makeTicket = async (name: string): Promise<string> => {
    ticketNumber += 1;
    const ticket = await db.ticket.create({ data: {
      projectId, number: ticketNumber, type: 'TASK', status: 'CREATED', priority: 'MEDIUM',
      title: `Memory system ${name}`,
    } });
    return ticket.id;
  };

  /** One `status_changed` ticket_event envelope, as a producer builds it for a real ticket. */
  const statusChanged = (eventId: string, ticketId: string): Record<string, unknown> => ({
    id: eventId,
    type: 'ticket_event',
    ticketId,
    projectId,
    actorId: rootId,
    actorType: 'user',
    action: 'status_changed',
    data: { newStatus: 'IN_PROGRESS' },
    timestamp: new Date().toISOString(),
  });

  /** Publish one ticket_event through the application's own fan-out, inside the outbox's context. */
  const publishTicketEvent = async (
    eventId: string,
    ticketId: string,
    overrides: Partial<OutboxRecord> = {},
  ): Promise<void> => {
    await withTestActor({ type: 'SYSTEM', id: 'outbox' }, () =>
      publisher.publish(outboxRecord('ticket_event', statusChanged(eventId, ticketId), overrides)));
  };

  /** Refuse one audit key for the rest of the case; the recorder is the application's own. */
  const failAuditFor = (key: string) => vi.spyOn(audit, 'record').mockImplementation(async (input) => {
    if (input.key === key) throw new Error('audit down');
  });

  /** One active memory item with a TTL in the past, as the governance run finds it. */
  const seedExpiredItem = async (subject: string): Promise<string> => {
    const item = await db.memoryItem.create({ data: {
      projectId, kind: 'FACT', subject, predicate: 'owner', object: 'stale', activeKey: `FACT:${subject}:owner`,
      status: 'active', confidence: 0.8, ttlAt: new Date(Date.now() - 60_000),
    } });
    return item.id;
  };

  /** Drops this file's governance entries, so a case asserts what its own run recorded. */
  const clearGovernanceEntries = () => db.auditEntry.deleteMany({ where: { key: GOVERN_KEY } });

  beforeAll(async () => {
    const previousEmbedding = process.env['EMBEDDING_PROVIDER'];
    savedMcp = process.env['MCP_ENABLED'];
    process.env['EMBEDDING_PROVIDER'] = 'fake';
    // 3-D19: the MCP route reads its own namespaced config at boot, so the flag has to be on before it.
    process.env['MCP_ENABLED'] = 'true';
    try {
      await resetDb();
      app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    } finally {
      if (previousEmbedding === undefined) delete process.env['EMBEDDING_PROVIDER'];
      else process.env['EMBEDDING_PROVIDER'] = previousEmbedding;
    }
    server = app.getHttpServer();
    db = fixtureDb(app);
    audit = app.get(AuditRecorder);
    publisher = app.get(FanOutPublisher);
    governance = app.get(MemoryGovernanceProcessor);

    const root = await request(server).post('/api/auth/register')
      .send({ email: 'mem-sys-root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    rootToken = data<{ accessToken: string }>(root).accessToken;
    rootId = (await db.user.findUniqueOrThrow({ where: { email: 'mem-sys-root@koda.test' } })).id;
    await grantBaseline(db, { type: 'USER', id: rootId });

    const project = await request(server).post('/api/projects').set(asRoot())
      .send({ name: 'Memory System', slug: SLUG, key: PROJECT_KEY }).expect(201);
    projectId = data<{ id: string }>(project).id;

    // The developer agent: its global `agent` baseline plus a project `developer` binding, so it holds
    // `memory.create` and `memory.decision.record` in this project and no other project key.
    const created = data<{ apiKey: string; agent: { id: string } }>(
      await request(server).post('/api/agents').set(asRoot())
        .send({ name: 'mem-sys-dev', slug: 'mem-sys-dev' }).expect(201),
    );
    agentId = created.agent.id;
    agentKey = created.apiKey;
    await grantBaseline(db, { type: 'AGENT', id: agentId });
    await grantRole(db, { type: 'AGENT', id: agentId }, 'developer', projectId);
  }, BOOT_TIMEOUT);

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      if (savedMcp === undefined) delete process.env['MCP_ENABLED'];
      else process.env['MCP_ENABLED'] = savedMcp;
    }
  });

  beforeEach(() => resetThrottle(app));

  // -------------------------------------------------------------------------
  // AC-1 .. AC-4 — a tool call records the tool's own context
  // -------------------------------------------------------------------------

  it('AC-1/2: an MCP add-memory call saves the item and records one memory.create entry as the agent', async () => {
    const answer = await callTool('koda_add_memory', {
      project: SLUG, kind: 'FACT', subject: 'tool', predicate: 'owner', object: 'Private tool fact',
    });

    const text = textOf(answer);
    expect(answer.isError).toBe(false);
    expect(text.startsWith('memory:')).toBe(true);
    const saved = /^memory:(\S+) saved/.exec(text);
    expect(saved).not.toBeNull();
    const memoryId = String(saved?.[1]);

    const rows = await entries('memory.create', memoryId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: 'memory.create',
      resourceType: 'memory-item',
      projectId,
      actorType: 'AGENT',
      actorId: agentId,
      origin: 'mcp',
      summary: 'created FACT',
    });
    // The entry names the item the tool actually stored.
    expect(await db.memoryItem.count({ where: { id: memoryId, projectId, subject: 'tool' } })).toBe(1);
  }, TIMEOUT);

  it('AC-3/4: an MCP decision call records one memory.decision.record entry as the agent', async () => {
    const answer = await callTool('koda_record_decision', {
      project: SLUG, topic: 'tool-topic', decision: 'Private tool decision',
    });

    const text = textOf(answer);
    expect(answer.isError).toBe(false);
    const recorded = /^decision memory:(\S+) recorded/.exec(text);
    expect(recorded).not.toBeNull();
    const memoryId = String(recorded?.[1]);

    const rows = await entries('memory.decision.record', memoryId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: 'memory.decision.record',
      resourceType: 'memory-item',
      projectId,
      actorType: 'AGENT',
      actorId: agentId,
      origin: 'mcp',
      summary: 'created DECISION',
    });
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-5 / AC-6 — a refused entry rolls the tool's write back, and the tool answers as a store failure
  // -------------------------------------------------------------------------

  it('AC-5/6: a rejected memory.create entry fails the call and leaves no item behind', async () => {
    const spy = failAuditFor('memory.create');
    const answer = await callTool('koda_add_memory', {
      project: SLUG, kind: 'FACT', subject: 'tool-fail', predicate: 'owner',
    }).finally(() => spy.mockRestore());

    expect(answer.isError).toBe(true);
    expect(textOf(answer).startsWith('error: koda_add_memory failed')).toBe(true);
    expect(await db.memoryItem.count({ where: { projectId, subject: 'tool-fail' } })).toBe(0);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-7 .. AC-10 — the outbox extraction records as SYSTEM/memory, once per item
  // -------------------------------------------------------------------------

  it('AC-7: a published ticket_event writes memory items that each record one entry as SYSTEM/memory', async () => {
    const ticketId = await makeTicket('sys');

    await publishTicketEvent('evt-sys', ticketId);

    const items = await db.memoryItem.findMany({ where: { projectId, sourceId: 'evt-sys' }, select: { id: true } });
    expect(items.length).toBeGreaterThanOrEqual(1);
    for (const item of items) {
      const written = await entries(EXTRACT_KEY, item.id);
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({
        key: EXTRACT_KEY,
        resourceType: 'memory-item',
        projectId,
        actorType: 'SYSTEM',
        actorId: 'memory',
        origin: 'system',
        summary: 'created FACT',
      });
    }
  }, TIMEOUT);

  it('AC-8: publishing the same ticket_event twice still records one entry per item', async () => {
    const ticketId = await makeTicket('sys-repeat');

    await publishTicketEvent('evt-sys-repeat', ticketId);
    await publishTicketEvent('evt-sys-repeat', ticketId);

    const items = await db.memoryItem.findMany({
      where: { projectId, subject: `ticket:${ticketId}` }, select: { id: true },
    });
    expect(items).toHaveLength(1);
    for (const item of items) expect(await entries(EXTRACT_KEY, item.id)).toHaveLength(1);
  }, TIMEOUT);

  it('AC-9/10: a rejected extraction entry fails the publication and writes no item', async () => {
    const ticketId = await makeTicket('sys-down');

    const spy = failAuditFor(EXTRACT_KEY);
    try {
      await expect(publishTicketEvent('evt-sys-down', ticketId)).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }

    expect(await db.memoryItem.count({ where: { projectId, subject: `ticket:${ticketId}` } })).toBe(0);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-11 .. AC-13 — one governance entry per project per run that changed rows
  // -------------------------------------------------------------------------

  it('AC-11/12: a cleanup that expired an item records one system.memory.govern entry and rejects the item', async () => {
    await clearGovernanceEntries();
    const itemId = await seedExpiredItem('ttl-1');

    await governance.scheduledCleanup();

    const rows = await db.auditEntry.findMany({ where: { key: GOVERN_KEY, resourceId: projectId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: GOVERN_KEY,
      resourceType: 'project',
      resourceId: projectId,
      projectId,
      actorType: 'SYSTEM',
      actorId: 'memory',
      origin: 'system',
      summary: 'expired 1, downranked 0, deduplicated 0, superseded 0',
    });
    expect(await db.memoryItem.findUniqueOrThrow({ where: { id: itemId } })).toMatchObject({ status: 'rejected' });
  }, TIMEOUT);

  it('AC-13: a second run that changed nothing records no second entry', async () => {
    await clearGovernanceEntries();
    await seedExpiredItem('ttl-2');

    await governance.scheduledCleanup();
    await governance.scheduledCleanup();

    expect(await db.auditEntry.count({ where: { key: GOVERN_KEY, resourceId: projectId } })).toBe(1);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // Failure handling — the failed entry changes nothing else
  // -------------------------------------------------------------------------

  it('AC-21: a failing extraction leaves the delivery\'s lastError on its outbox row', async () => {
    const ticketId = await makeTicket('sys-last-error');
    const row = await db.outboxEvent.create({ data: {
      type: 'ticket_event', eventId: 'evt-last-error', projectId,
      payload: JSON.stringify(statusChanged('evt-last-error', ticketId)),
      status: 'processing', nextAttemptAt: new Date(0),
    } });

    const spy = failAuditFor(EXTRACT_KEY);
    // The envelope names the row the publisher records the failure on; without a row, that write is a no-op.
    try {
      await expect(publishTicketEvent('evt-last-error', ticketId, { id: row.id })).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }

    const stored = await db.outboxEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.lastError).toContain('audit down');
  }, TIMEOUT);

  it('AC-22: a rejected governance entry leaves the cleanup\'s expiry in place', async () => {
    await clearGovernanceEntries();
    const itemId = await seedExpiredItem('ttl-3');

    const spy = failAuditFor(GOVERN_KEY);
    await expect(governance.scheduledCleanup()).rejects.toThrow('Governance cleanup failed for 1 project(s)');
    spy.mockRestore();

    // The cleanup's writes run before the entry and outside its transaction, so they stay.
    expect(await db.memoryItem.findUniqueOrThrow({ where: { id: itemId } })).toMatchObject({ status: 'rejected' });
    expect(await db.auditEntry.count({ where: { key: GOVERN_KEY, resourceId: projectId } })).toBe(0);
  }, TIMEOUT);
});
