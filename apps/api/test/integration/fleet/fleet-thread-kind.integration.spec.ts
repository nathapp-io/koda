/**
 * Fleet S5b US-002 — thread kind and the REPO-only guard (PG): the `kind` column defaults to REPO, a PROJECT row
 * needs no repo fields at all, the 20261017090000_chat_thread_kind migration backfills rows written before it,
 * `GET /projects/:slug/threads/:id` answers kind PROJECT with null repo fields, and Plan, Run, Publish and Discard
 * answer 409 `threads.notRepoThread` for a PROJECT thread.
 *
 * Acceptance setup: app.get(FLEET_CFG).threadsEnabled = true, project `web`, member `dev` (DEVELOPER) who created
 * the thread; requests as dev.
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/fleet-thread-kind.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { applyMigration, scratchSchemaBefore, ScratchSchema } from '../../helpers/migration-schema';
import { FLEET_CFG, IFleetConfig } from '../../../src/config/fleet.config';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
// The migration block replays every committed migration before the target, as the sibling schema specs do.
vi.setConfig({ testTimeout: 20_000 });
const MIGRATION = '20261017090000_chat_thread_kind';

describeIntegration('fleet thread kind (PG, US-002)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let seq = 0;

  const cfg = () => app.get<IFleetConfig>(FLEET_CFG, { strict: false });
  const asDev = () => ({ Authorization: `Bearer ${world.tokens.dev}` });

  /** A PROJECT thread row: kind PROJECT, no repoId, baseRef, feature or specPath. */
  const projectThread = (over: Record<string, unknown> = {}) => prisma.chatThread.create({ data: {
    projectId: world.projectId, kind: 'PROJECT', repoId: null, baseRef: null, feature: null, specPath: null,
    title: `Project thread ${++seq}`, createdById: world.ids.dev, backend: { kind: 'native', model: 'm1' }, skills: [],
    ...over,
  } });

  const projectRoute = (id: string, route: string) =>
    request(server).post(`/api/projects/web/threads/${id}/${route}`).set(asDev()).send({});

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    cfg().threadsEnabled = true;
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  it('AC-1: a ChatThread row inserted with no kind value stores kind REPO', async () => {
    const thread = await prisma.chatThread.create({ data: {
      projectId: world.projectId, repoId: world.repoId, baseRef: 'trunk', feature: `kind-default-${++seq}`,
      title: 'Kind default', createdById: world.ids.dev, backend: { kind: 'native', model: 'm1' }, skills: [],
      specPath: '.nax/features/kind-default/spec.md',
    } });
    const rows = await prisma.$queryRaw<Array<{ kind: string }>>`SELECT "kind" FROM "ChatThread" WHERE "id" = ${thread.id}`;
    expect(rows).toEqual([{ kind: 'REPO' }]);
    expect((await prisma.chatThread.findUniqueOrThrow({ where: { id: thread.id } })).kind).toBe('REPO');
  });

  it('AC-2: a ChatThread row with kind PROJECT and null repoId, baseRef, feature and specPath is inserted', async () => {
    const thread = await projectThread();
    const row = await prisma.chatThread.findUniqueOrThrow({ where: { id: thread.id } });
    expect(row).toMatchObject({ kind: 'PROJECT', repoId: null, baseRef: null, feature: null, specPath: null });
  });

  it('AC-6: GET /api/projects/:slug/threads/:id for a PROJECT thread answers 200 with kind PROJECT', async () => {
    const thread = await projectThread();
    const res = await request(server).get(`/api/projects/web/threads/${thread.id}`).set(asDev()).expect(200);
    expect(data<{ kind: string }>(res).kind).toBe('PROJECT');
  });

  it('AC-7: GET /api/projects/:slug/threads/:id for a PROJECT thread answers 200 with repoId, baseRef, feature and specPath null', async () => {
    const thread = await projectThread();
    const res = await request(server).get(`/api/projects/web/threads/${thread.id}`).set(asDev()).expect(200);
    expect(data<Record<string, unknown>>(res))
      .toMatchObject({ repoId: null, baseRef: null, feature: null, specPath: null });
  });

  it('AC-6: GET answers kind REPO for a REPO thread, whose repo fields are unchanged', async () => {
    const thread = await prisma.chatThread.create({ data: {
      projectId: world.projectId, repoId: world.repoId, baseRef: 'trunk', feature: `kind-repo-${++seq}`,
      title: 'Kind repo', createdById: world.ids.dev, backend: { kind: 'native', model: 'm1' }, skills: [],
      specPath: `.nax/features/kind-repo-${seq}/spec.md`,
    } });
    const res = await request(server).get(`/api/projects/web/threads/${thread.id}`).set(asDev()).expect(200);
    expect(data<Record<string, unknown>>(res)).toMatchObject({
      kind: 'REPO', repoId: world.repoId, baseRef: 'trunk', feature: `kind-repo-${seq}`, specPath: `.nax/features/kind-repo-${seq}/spec.md`,
    });
  });

  it('AC-11: POST /api/projects/:slug/threads/:id/plan by the creator of a PROJECT thread answers 409 threads.notRepoThread', async () => {
    const thread = await projectThread();
    const res = await projectRoute(thread.id, 'plan').expect(409);
    expect(res.body.message).toBe('This action needs a repository thread');
    expect(res.body.ret).not.toBe(0);
  });

  it('AC-12: POST /api/projects/:slug/threads/:id/run by the creator of a PROJECT thread answers 409 threads.notRepoThread', async () => {
    const thread = await projectThread();
    const res = await projectRoute(thread.id, 'run').expect(409);
    expect(res.body.message).toBe('This action needs a repository thread');
    expect(res.body.ret).not.toBe(0);
  });

  it('AC-13: POST /api/projects/:slug/threads/:id/publish by the creator of a PROJECT thread answers 409 threads.notRepoThread', async () => {
    const thread = await projectThread();
    const res = await projectRoute(thread.id, 'publish').expect(409);
    expect(res.body.message).toBe('This action needs a repository thread');
    expect(res.body.ret).not.toBe(0);
  });

  it('AC-14: POST /api/projects/:slug/threads/:id/discard by the creator of a PROJECT thread answers 409 threads.notRepoThread', async () => {
    const thread = await projectThread();
    const res = await projectRoute(thread.id, 'discard').expect(409);
    expect(res.body.message).toBe('This action needs a repository thread');
    expect(res.body.ret).not.toBe(0);
  });

  it('the kind refusal precedes the creator check on plan', async () => {
    // The project admin (root) is not the thread's creator: the creator check would answer 403 notCreator.
    const thread = await projectThread();
    const res = await request(server).post(`/api/projects/web/threads/${thread.id}/plan`)
      .set({ Authorization: `Bearer ${world.tokens.root}` }).send({}).expect(409);
    expect(res.body.message).toBe('This action needs a repository thread');
    expect(thread.createdById).toBe(world.ids.dev);
  });

  it('a PROJECT thread send answers the kind refusal until US-004 adds the PROJECT session branch', async () => {
    const thread = await projectThread();
    const res = await request(server).post(`/api/projects/web/threads/${thread.id}/messages`).set(asDev())
      .send({ text: 'hello', clientMessageId: 'cm-project-1' }).expect(409);
    expect(res.body.message).toBe('This action needs a repository thread');
  });

  describe('the migration itself', () => {
    let scratch: ScratchSchema;
    const schema = 'chat_thread_kind_mig';
    const preThread = 'thread-pre-kind';

    beforeAll(async () => {
      scratch = await scratchSchemaBefore(process.env.DATABASE_URL as string, schema, MIGRATION);
      // A project, its repo, the creator and one thread row, written by the schema that precedes the migration.
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
         VALUES ('${preThread}', 'p-pre', 'repo-pre', 'trunk', 'pre-kind', 'Pre kind', 'u-pre', '{"kind":"native","model":"m1"}', 'ACTIVE', '[]', '.nax/features/pre-kind/spec.md')`,
      );
      await applyMigration(scratch.db, MIGRATION);
    }, 120_000);

    afterAll(async () => {
      await scratch.drop();
    });

    it('AC-4: the pre-existing ChatThread row is left with kind REPO', async () => {
      const rows = await scratch.db.$queryRawUnsafe<Array<{ kind: string }>>(
        `SELECT "kind" FROM "ChatThread" WHERE "id" = '${preThread}'`,
      );
      expect(rows).toEqual([{ kind: 'REPO' }]);
    });

    it('AC-5: the pre-existing ChatThread row keeps its repoId, feature and specPath', async () => {
      const rows = await scratch.db.$queryRawUnsafe<Array<{ repoId: string; feature: string; specPath: string }>>(
        `SELECT "repoId", "feature", "specPath" FROM "ChatThread" WHERE "id" = '${preThread}'`,
      );
      expect(rows).toEqual([{ repoId: 'repo-pre', feature: 'pre-kind', specPath: '.nax/features/pre-kind/spec.md' }]);
    });

    it('accepts a PROJECT row with null repo fields after the migration', async () => {
      await scratch.db.$executeRawUnsafe(
        `INSERT INTO "ChatThread" ("id", "projectId", "kind", "title", "createdById", "backend", "status", "skills")
         VALUES ('thread-post-kind', 'p-pre', 'PROJECT', 'Post kind', 'u-pre', '{"kind":"native","model":"m1"}', 'ACTIVE', '[]')`,
      );
      const rows = await scratch.db.$queryRawUnsafe<Array<{ kind: string; repoId: string | null }>>(
        `SELECT "kind", "repoId" FROM "ChatThread" WHERE "id" = 'thread-post-kind'`,
      );
      expect(rows).toEqual([{ kind: 'PROJECT', repoId: null }]);
    });
  });
});
