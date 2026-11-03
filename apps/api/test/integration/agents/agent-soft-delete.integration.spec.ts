import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Review P2 remainder (US-007) — deleting an agent is a soft delete.
 *
 * The row stays behind so the agent's past work keeps its author: its comments keep
 * `authorAgentId`, its created tickets keep `createdByAgentId` and its assigned tickets keep
 * `assignedToAgentId`. What the delete *does* take away is the agent's identity: the key hash is
 * replaced by a dead `deleted:` value, the status becomes OFFLINE and the slug is renamed to
 * `${slug}~deleted-${id}`, which frees the original slug for a new agent.
 *
 * Repository, service and HTTP criteria live in one file because they share one reset: the
 * repository half talks to its own client (no action-context guard), the service/HTTP half goes
 * through the booted application.
 *
 * Run: cd apps/api && bun run test:db:up && KODA_DB_TESTS=1 bunx vitest run \
 *   test/integration/agents/agent-soft-delete.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { AgentsService } from '../../../src/agents/agents.service';
import { PrismaAgentRepository } from '../../../src/agents/prisma-agent.repository';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { asTestActor, fixtureDb } from '../../helpers/action-context';
import { createTestPrismaClient } from '../../helpers/test-prisma';

const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('agent soft delete (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let raw: PrismaClient;
  let repo: PrismaAgentRepository;
  let ownerToken: string;
  let ownerId: string;
  let serial = 0;

  const agentRow = (over: { slug: string }) =>
    raw.agent.create({ data: { name: over.slug, slug: over.slug, apiKeyHash: `hash-${over.slug}` } });
  const project = async () => {
    const n = ++serial;
    return db.project.create({ data: { name: `soft-${n}`, slug: `soft-${n}`, key: `SF${n}` } });
  };
  const viaOwner = <T extends object>(target: T) => asTestActor(target, { type: 'USER', id: ownerId });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    server = app.getHttpServer();
    db = fixtureDb(app);
    raw = createTestPrismaClient();
    repo = new PrismaAgentRepository({ client: raw } as unknown as PrismaService<PrismaClient>);
    // The first registered user is the installation's Owner (role `owner`, entries `*`).
    ownerToken = data<{ accessToken: string }>(
      await request(server).post('/api/auth/register')
        .send({ email: 'soft-delete-owner@koda.test', name: 'Owner', password: TEST_PASSWORD })
        .expect(201),
    ).accessToken;
    ownerId = (await db.user.findUniqueOrThrow({ where: { email: 'soft-delete-owner@koda.test' } })).id;
  }, 60_000);
  beforeEach(() => { resetThrottle(app); });
  afterAll(async () => { await raw?.$disconnect(); await app?.close(); });

  describe('PrismaAgentRepository.softDeleteById', () => {
    it('AC-1/2/3/4: tombstones the row in place, offline with a dead key and a renamed slug', async () => {
      const agent = await agentRow({ slug: 'tombstone-bot' });
      const tombstone = await repo.softDeleteById(agent.id);
      const row = await raw.agent.findUniqueOrThrow({ where: { id: agent.id } });

      expect(tombstone).not.toBeNull();
      expect(row.deletedAt).toBeInstanceOf(Date);
      expect(row.status).toBe('OFFLINE');
      expect(row.apiKeyHash).toMatch(/^deleted:[a-f0-9]{64}$/);
      expect(row.apiKeyHash).not.toBe(agent.apiKeyHash);
      expect(row.slug).toBe(`tombstone-bot~deleted-${agent.id}`);
    });

    it('AC-5: answers the tombstone with its capabilities and its original slug', async () => {
      const agent = await agentRow({ slug: 'capability-bot' });
      await raw.agentCapabilityEntry.createMany({
        data: [
          { agentId: agent.id, capability: 'typescript' },
          { agentId: agent.id, capability: 'nax' },
        ],
      });

      const tombstone = await repo.softDeleteById(agent.id);

      expect(tombstone?.id).toBe(agent.id);
      expect(tombstone?.slug).toBe('capability-bot');
      expect((tombstone?.capabilities ?? []).map((row) => row.capability).sort()).toEqual(['nax', 'typescript']);
    });

    it('AC-6: an already soft-deleted agent answers null and keeps its first tombstone', async () => {
      const agent = await agentRow({ slug: 'twice-bot' });
      expect(await repo.softDeleteById(agent.id)).not.toBeNull();
      const first = await raw.agent.findUniqueOrThrow({ where: { id: agent.id } });

      expect(await repo.softDeleteById(agent.id)).toBeNull();

      const second = await raw.agent.findUniqueOrThrow({ where: { id: agent.id } });
      expect(second.slug).toBe(first.slug);
      expect(second.apiKeyHash).toBe(first.apiKeyHash);
      expect(second.deletedAt?.getTime()).toBe(first.deletedAt?.getTime());
    });
  });

  describe('AgentsService deletion keeps historical foreign keys', () => {
    it('AC-7/8/9: the tombstoned agent keeps its comment and both ticket links', async () => {
      const agent = await agentRow({ slug: 'history-bot' });
      const p = await project();
      const ticket = await db.ticket.create({
        data: {
          projectId: p.id, number: 1, type: 'TASK', title: 'past work',
          createdByAgentId: agent.id, assignedToAgentId: agent.id,
        },
      });
      const comment = await db.comment.create({ data: { ticketId: ticket.id, body: 'done', authorAgentId: agent.id } });

      await viaOwner(app.get(AgentsService)).removeById(agent.id);

      const [commentRow, ticketRow] = await Promise.all([
        db.comment.findUniqueOrThrow({ where: { id: comment.id } }),
        db.ticket.findUniqueOrThrow({ where: { id: ticket.id } }),
      ]);
      expect(commentRow.authorAgentId).toBe(agent.id);
      expect(ticketRow.createdByAgentId).toBe(agent.id);
      expect(ticketRow.assignedToAgentId).toBe(agent.id);
      expect((await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).deletedAt).toBeInstanceOf(Date);
    });

    it('AC-10/11: remove(slug) drops every binding and records one agent.delete entry naming the id', async () => {
      const agent = await agentRow({ slug: 'binding-bot' });
      const p = await project();
      await grantRole(db, { type: 'AGENT', id: agent.id }, 'viewer', p.id);
      expect(await db.roleBinding.count({ where: { principalType: 'AGENT', principalId: agent.id } })).toBeGreaterThan(0);

      const removed = await viaOwner(app.get(AgentsService)).remove('binding-bot');

      expect(removed).toMatchObject({ id: agent.id, slug: 'binding-bot' });
      expect(await db.roleBinding.count({ where: { principalType: 'AGENT', principalId: agent.id } })).toBe(0);
      // The bindings are gone, the row is not: it stays behind as the tombstone its history points at.
      expect(await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).toMatchObject({
        deletedAt: expect.any(Date), slug: `binding-bot~deleted-${agent.id}`,
      });
      const entries = await db.auditEntry.findMany({ where: { key: 'agent.delete', resourceId: agent.id }, take: 10 });
      expect(entries).toHaveLength(1);
      expect(entries[0].summary).toBe('deleted binding-bot');
    });
  });

  describe('DELETE /api/agents/:slug by the Owner (no wait policy seeded)', () => {
    const createAgent = async (slug: string) => data<{ agent: { id: string; slug: string } }>(
      await request(server).post('/api/agents')
        .auth(ownerToken, { type: 'bearer' })
        .send({ name: slug, slug })
        .expect(201),
    ).agent;
    const remove = (slug: string) =>
      request(server).delete(`/api/agents/${slug}`).auth(ownerToken, { type: 'bearer' });

    it('a concurrent delete wins without replacing retained capabilities or recording a failed PATCH as success', async () => {
      const agent = await createAgent('concurrent-capabilities');
      await raw.agentCapabilityEntry.create({ data: { agentId: agent.id, capability: 'original' } });
      const original = await raw.agentCapabilityEntry.findMany({ where: { agentId: agent.id } });
      const service = viaOwner(app.get(AgentsService));
      const tx = app.get<ITransactionManager>(TRANSACTION_MANAGER);
      let release!: () => void;
      let deleted!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const ready = new Promise<void>((resolve) => { deleted = resolve; });
      const deletion = tx.run(async () => {
        await service.removeById(agent.id);
        deleted();
        await held;
      });
      let pending: Promise<unknown> | undefined;
      let readFinished = false;
      let pid: number | undefined;
      const liveRepo = app.get(PrismaAgentRepository);
      const read = liveRepo.findByIdScalar.bind(liveRepo);
      const spy = vi.spyOn(liveRepo, 'findByIdScalar').mockImplementation(async (id, options) => {
        const [backend] = await app.get<PrismaService<PrismaClient>>(PrismaService).client
          .$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        pid = backend.pid;
        try { return await read(id, options); }
        finally { readFinished = true; }
      });
      try {
        await ready;
        pending = service.updateCapabilities(agent.id, { capabilities: ['overwrite'] }).catch((error: unknown) => error);
        // Wait for database evidence, not a sleep-based guess: deletion holds the parent row,
        // and the capability writer must wait on it *before* deciding the agent is live.
        const deadline = Date.now() + 2_000;
        let blocked = false;
        while (!readFinished && !blocked && Date.now() < deadline) {
          if (pid !== undefined) {
            const [state] = await raw.$queryRaw<{ blocked: boolean }[]>`
              SELECT cardinality(pg_blocking_pids(${pid}::int)) > 0 AS blocked
            `;
            blocked = state.blocked;
          }
          if (!blocked && !readFinished) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
        expect(readFinished).toBe(false);
      } finally {
        release();
        await deletion;
        // Drain the writer before restoring its repository spy, even if an assertion fails.
        if (pending) await pending;
        spy.mockRestore();
      }
      const result = await pending;
      expect(result).toBeInstanceOf(NotFoundAppException);
      expect((result as NotFoundAppException).prefix).toBe('agents');
      expect(await raw.agentCapabilityEntry.findMany({ where: { agentId: agent.id } })).toEqual(original);
      expect(await db.auditEntry.count({ where: { key: 'agent.capabilities.update', resourceId: agent.id } })).toBe(0);
      expect((await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).deletedAt).toBeInstanceOf(Date);
    });

    it('AC-14/16: answers 200 with the original slug', async () => {
      await createAgent('http-delete-bot');

      const res = await remove('http-delete-bot').expect(200);

      expect(data<{ slug: string }>(res).slug).toBe('http-delete-bot');
    });

    it('AC-15: a second DELETE of the same original slug answers 404', async () => {
      const agent = await createAgent('http-twice-bot');
      await remove('http-twice-bot').expect(200);

      // The row survives, so the 404 comes from the freed slug, not from a missing agent.
      expect(await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).toMatchObject({
        deletedAt: expect.any(Date), slug: `http-twice-bot~deleted-${agent.id}`,
      });
      await remove('http-twice-bot').expect(404);
    });

    it('AC-17: the audit summary names the original slug', async () => {
      const agent = await createAgent('http-audit-bot');
      await remove('http-audit-bot').expect(200);

      const entries = await db.auditEntry.findMany({ where: { key: 'agent.delete', resourceId: agent.id }, take: 10 });
      expect(entries).toHaveLength(1);
      // The tombstone stores a renamed slug; the entry names the agent as it was when it was deleted.
      expect(entries[0].summary).toBe('deleted http-audit-bot');
      expect((await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).slug).toBe(`http-audit-bot~deleted-${agent.id}`);
    });

    it('AC-18: the freed slug is reusable by POST /api/agents', async () => {
      const original = await createAgent('http-reuse-bot');
      await remove('http-reuse-bot').expect(200);

      const replacement = await createAgent('http-reuse-bot');

      expect(replacement.id).not.toBe(original.id);
      expect(replacement.slug).toBe('http-reuse-bot');
      const rows = await db.agent.findMany({ where: { OR: [{ id: original.id }, { id: replacement.id }] }, take: 10 });
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.id === original.id)).toMatchObject({ deletedAt: expect.any(Date), status: 'OFFLINE' });
    });
  });
});
