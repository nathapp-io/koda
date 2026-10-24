/**
 * Permissions P1 US-001 — threads record their creator's and requester's type (PG).
 *
 * A thread row stores `createdByType` from the action context of its creator, a message stores `authorType` from its
 * sender, the THREAD job stores the turn's requester (the sender or the caller) in `requestedById`/`requestedByType`,
 * and `findCallContext` answers that requester — a user's identity, or an agent's slug and status — instead of the
 * thread's creator. The migration drops both `User` foreign keys, so an agent id may stand where a user id did.
 *
 * Acceptance setup: FLEET_THREADS_ENABLED=true, project `web` with an anchor fleet repo, users `dev`/`root` from the
 * shared world, one agent `a1`. Every service call runs inside `runWithActor` as its principal.
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/thread-creator-type.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { runWithActor } from '../../../src/action-context/action-context';
import { ThreadsService } from '../../../src/fleet/threads/threads.service';
import { PrismaAssistantToolCallRepository } from '../../../src/fleet/assistant/prisma-assistant-tool-call.repository';
import { FLEET_CFG, IFleetConfig } from '../../../src/config/fleet.config';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { applyMigration, scratchSchemaBefore, ScratchSchema } from '../../helpers/migration-schema';
import { expectGuardActive, fixtureDb, withTestActor } from '../../helpers/action-context';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
vi.setConfig({ testTimeout: 20_000 });

const MIGRATION = '20261031090000_thread_creator_type';

/** A valid PROJECT thread body: no repo fields, native backend (2aw-D3). */
const projectThreadInput = (title: string) => ({ kind: 'PROJECT' as const, title, backend: { kind: 'native' as const, model: 'm1' } });

describeIntegration('thread creator and requester type (PG, US-001)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let threads: ThreadsService;
  let calls: PrismaAssistantToolCallRepository;
  let agent: { id: string; slug: string; apiKey: string };
  let seq = 0;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    agent = await seedFleetHttpAgent(app.getHttpServer(), world.tokens.root);
    threads = app.get(ThreadsService, { strict: false });
    calls = app.get(PrismaAssistantToolCallRepository, { strict: false });
    app.get<IFleetConfig>(FLEET_CFG, { strict: false }).threadsEnabled = true;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  /** A PROJECT thread of `web` created by `creatorId` acting as `type`. */
  const createThread = (creatorId: string, type: 'USER' | 'AGENT') =>
    runWithActor({ type, id: creatorId }, () => threads.create(world.projectId, creatorId, projectThreadInput(`Requester ${++seq}`)));

  /** A message from `senderId` on its own thread, which creates the thread's first THREAD job. */
  const send = (threadId: string, senderId: string, type: 'USER' | 'AGENT') =>
    runWithActor({ type, id: senderId }, () => threads.sendMessage(world.projectId, threadId, senderId, { text: 'hello', clientMessageId: `cm-${++seq}` }));

  const threadJob = (threadId: string) => prisma.fleetJob.findFirstOrThrow({ where: { threadId, command: 'THREAD' } });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it("AC-1: create inside an AGENT context stores createdById the agent's id and createdByType 'AGENT'", async () => {
    const created = await createThread(agent.id, 'AGENT');
    const row = await prisma.chatThread.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.createdById).toBe(agent.id);
    expect(row.createdByType).toBe('AGENT');
  });

  it("AC-2: create outside any principal context stores createdByType 'USER'", async () => {
    // The guard refuses a write with no context at all, so the no-principal case is only reachable from a
    // system component now; `actorTypeFor` answers 'USER' for it exactly as it does with no context.
    const created = await withTestActor({ type: 'SYSTEM', id: 'seed' }, () =>
      threads.create(world.projectId, world.ids.dev, projectThreadInput('No context')));
    const row = await prisma.chatThread.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.createdById).toBe(world.ids.dev);
    expect(row.createdByType).toBe('USER');
  });

  it("AC-3: sendMessage inside an AGENT context creates a THREAD job requested by the agent", async () => {
    const thread = await createThread(agent.id, 'AGENT');
    await send(thread.id, agent.id, 'AGENT');
    const job = await threadJob(thread.id);
    expect(job.requestedById).toBe(agent.id);
    expect(job.requestedByType).toBe('AGENT');
  });

  it("AC-12: that agent's send stores the user message with authorUserId the agent's id and authorType 'AGENT'", async () => {
    const thread = await createThread(agent.id, 'AGENT');
    await send(thread.id, agent.id, 'AGENT');
    const message = await prisma.chatMessage.findFirstOrThrow({ where: { threadId: thread.id, role: 'user' } });
    expect(message.authorUserId).toBe(agent.id);
    expect(message.authorType).toBe('AGENT');
  });

  it("a user's send stores the user message with authorType 'USER'", async () => {
    const thread = await createThread(world.ids.dev, 'USER');
    await send(thread.id, world.ids.dev, 'USER');
    const message = await prisma.chatMessage.findFirstOrThrow({ where: { threadId: thread.id, role: 'user' } });
    expect(message).toMatchObject({ authorUserId: world.ids.dev, authorType: 'USER' });
  });

  it('AC-4: findCallContext answers the job requester agent, not the thread creator', async () => {
    const thread = await createThread(world.ids.dev, 'USER');
    await send(thread.id, world.ids.dev, 'USER');
    const job = await threadJob(thread.id);
    await prisma.fleetJob.update({ where: { id: job.id }, data: { requestedById: agent.id, requestedByType: 'AGENT' } });
    const context = await calls.findCallContext(job.id);
    const agentRow = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(context?.creator).toEqual({ type: 'AGENT', id: agent.id, slug: agentRow.slug, status: agentRow.status });
    expect(context?.threadId).toBe(thread.id);
  });

  it("AC-5: findCallContext answers the user requester with type 'USER' and its identity", async () => {
    const thread = await createThread(world.ids.dev, 'USER');
    await send(thread.id, world.ids.dev, 'USER');
    const job = await threadJob(thread.id);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: world.ids.dev } });
    expect((await calls.findCallContext(job.id))?.creator).toEqual({
      type: 'USER', id: user.id, email: user.email, role: 'MEMBER', disabled: user.disabled,
    });
  });

  it('AC-6: findCallContext answers null when the requesting agent row is gone', async () => {
    const thread = await createThread(world.ids.dev, 'USER');
    await send(thread.id, world.ids.dev, 'USER');
    const job = await threadJob(thread.id);
    const gone = await seedFleetHttpAgent(app.getHttpServer(), world.tokens.root);
    await prisma.fleetJob.update({ where: { id: job.id }, data: { requestedById: gone.id, requestedByType: 'AGENT' } });
    await prisma.agent.delete({ where: { id: gone.id } });
    expect(await calls.findCallContext(job.id)).toBeNull();
  });

  describe('the migration itself', () => {
    let scratch: ScratchSchema;
    const schema = 'thread_creator_type_mig';

    beforeAll(async () => {
      scratch = await scratchSchemaBefore(process.env.DATABASE_URL as string, schema, MIGRATION);
      // A project, the creator and one thread with one message, written by the schema that precedes the migration.
      await scratch.db.$executeRawUnsafe(
        `INSERT INTO "User" ("id", "email", "name", "passwordHash", "role", "tokenVersion", "disabled", "createdAt", "updatedAt")
         VALUES ('u-pre', 'pre@koda.test', 'Pre', 'x', 'ADMIN', 0, false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      );
      await scratch.db.$executeRawUnsafe(
        `INSERT INTO "Project" ("id", "name", "slug", "key", "autoIndexOnClose", "autoAssign", "graphifyEnabled", "createdAt", "updatedAt")
         VALUES ('p-pre', 'Pre', 'pre', 'PRE', true, 'OFF', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      );
      await scratch.db.$executeRawUnsafe(
        `INSERT INTO "FleetRepo" ("id", "projectId", "provider", "owner", "name", "defaultBranch", "createdById", "createdAt")
         VALUES ('repo-pre', 'p-pre', 'github', 'acme', 'pre', 'trunk', 'u-pre', CURRENT_TIMESTAMP)`,
      );
      await scratch.db.$executeRawUnsafe(
        `INSERT INTO "ChatThread" ("id", "projectId", "repoId", "baseRef", "feature", "title", "createdById", "backend", "status", "skills", "specPath")
         VALUES ('thread-pre-type', 'p-pre', 'repo-pre', 'trunk', 'pre-type', 'Pre type', 'u-pre', '{"kind":"native","model":"m1"}', 'ACTIVE', '[]', '.nax/features/pre-type/spec.md')`,
      );
      await scratch.db.$executeRawUnsafe(
        `INSERT INTO "ChatMessage" ("id", "threadId", "seq", "role", "authorUserId", "content", "status")
         VALUES ('msg-pre-type', 'thread-pre-type', 1, 'user', 'u-pre', 'hi', 'complete')`,
      );
      await applyMigration(scratch.db, MIGRATION);
    }, 180_000);

    afterAll(async () => {
      await scratch.drop();
    });

    it("leaves a pre-existing thread with createdByType 'USER' and its message authorType null", async () => {
      const thread = await scratch.db.$queryRawUnsafe<Array<{ createdByType: string }>>(
        `SELECT "createdByType" FROM "ChatThread" WHERE "id" = 'thread-pre-type'`,
      );
      const message = await scratch.db.$queryRawUnsafe<Array<{ authorType: string | null }>>(
        `SELECT "authorType" FROM "ChatMessage" WHERE "id" = 'msg-pre-type'`,
      );
      expect(thread).toEqual([{ createdByType: 'USER' }]);
      expect(message).toEqual([{ authorType: null }]);
    });

    it('drops the user foreign keys, so an agent id may be written to either column', async () => {
      await scratch.db.$executeRawUnsafe(
        `INSERT INTO "ChatThread" ("id", "projectId", "title", "createdById", "createdByType", "backend", "status", "skills")
         VALUES ('thread-agent', 'p-pre', 'Agent', 'agent-x', 'AGENT', '{"kind":"native","model":"m1"}', 'ACTIVE', '[]')`,
      );
      await scratch.db.$executeRawUnsafe(
        `INSERT INTO "ChatMessage" ("id", "threadId", "seq", "role", "authorUserId", "authorType", "content", "status")
         VALUES ('msg-agent', 'thread-agent', 1, 'user', 'agent-x', 'AGENT', 'hi', 'complete')`,
      );
      const rows = await scratch.db.$queryRawUnsafe<Array<{ createdByType: string; authorType: string }>>(
        `SELECT t."createdByType", m."authorType" FROM "ChatThread" t JOIN "ChatMessage" m ON m."threadId" = t."id"
         WHERE t."id" = 'thread-agent'`,
      );
      expect(rows).toEqual([{ createdByType: 'AGENT', authorType: 'AGENT' }]);
    });

    it('keeps the (createdById, kind, lastActivityAt) index', async () => {
      const rows = await scratch.db.$queryRawUnsafe<Array<{ indexname: string }>>(
        `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'ChatThread_createdById_kind_lastActivityAt_idx'`,
      );
      expect(rows).toHaveLength(1);
    });
  });
});
