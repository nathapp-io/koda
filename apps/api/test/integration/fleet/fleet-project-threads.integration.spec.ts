/**
 * Fleet S5b US-003 — creating PROJECT threads (PG): the deterministic anchor lookup of
 * `IFleetRepoRepository.findAnchor`, `POST /api/projects/:slug/threads` with `kind: 'PROJECT'` (201, a row with no
 * repo fields at all), the `threads.noFleetRepo` 409 of a project without a fleet repo and the kind in the list route.
 *
 * Acceptance setup: app.get(FLEET_CFG).threadsEnabled = true, project `web`, member `dev` (DEVELOPER); requests as dev.
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/fleet-project-threads.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { expectBindingOnlyFixtures, grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { PrismaFleetRepoRepository } from '../../../src/fleet/repos/prisma-fleet-repo.repository';
import { FLEET_CFG, IFleetConfig } from '../../../src/config/fleet.config';
import { expectGuardActive, fixtureDb } from '../../helpers/action-context';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
vi.setConfig({ testTimeout: 20_000 });

describeIntegration('fleet project threads (PG, US-003)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let repoRepo: PrismaFleetRepoRepository;
  let emptySlug: string;
  let seq = 0;

  const cfg = () => app.get<IFleetConfig>(FLEET_CFG, { strict: false });
  const asDev = () => ({ Authorization: `Bearer ${world.tokens.dev}` });

  /** A project with no fleet repo at all, with `dev` holding a developer binding so the create route reaches the service. */
  const seedRepoLessProject = async (): Promise<string> => {
    const slug = `empty-${++seq}`;
    const project = await prisma.project.create({ data: { name: slug, slug, key: `E${seq}` } });
    await grantRole(prisma, { type: 'USER', id: world.ids.dev }, 'developer', project.id);
    return slug;
  };

  const createProjectThread = (slug: string, body: Record<string, unknown>) =>
    request(server).post(`/api/projects/${slug}/threads`).set(asDev()).send(body);

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(server, prisma);
    cfg().threadsEnabled = true;
    repoRepo = app.get(PrismaFleetRepoRepository, { strict: false });
    emptySlug = await seedRepoLessProject();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('fixtures grant through bindings only', async () => {
    await expectBindingOnlyFixtures(prisma, [
      { type: 'USER', id: world.ids.root },
      { type: 'USER', id: world.ids.dev },
      { type: 'USER', id: world.ids.viewer },
      { type: 'USER', id: world.ids.outsider },
    ]);
  });

  it('AC-9: findAnchor returns the project repo with the earlier createdAt', async () => {
    const project = await prisma.project.create({ data: { name: 'Anchor order', slug: 'anchor-order', key: 'ANC1' } });
    const repo = (id: string, name: string, createdAt: string) => prisma.fleetRepo.create({ data: {
      id, projectId: project.id, provider: 'github', owner: 'acme', name, defaultBranch: 'main', createdById: world.ids.root,
      createdAt: new Date(createdAt),
    } });
    // Inserted newest-first on purpose: the anchor is the oldest by `createdAt`, not the first row written.
    const later = await repo('anchor-later', 'later', '2026-02-02T00:00:00.000Z');
    const earlier = await repo('anchor-earlier', 'earlier', '2026-02-01T00:00:00.000Z');
    // A tie on `createdAt` is broken by the smallest id.
    await repo('anchor-tie-b', 'tie-b', '2026-03-01T00:00:00.000Z');
    const tieA = await repo('anchor-tie-a', 'tie-a', '2026-03-01T00:00:00.000Z');

    expect((await repoRepo.findAnchor(project.id))?.id).toBe(earlier.id);
    await prisma.fleetRepo.delete({ where: { id: earlier.id } });
    expect((await repoRepo.findAnchor(project.id))?.id).toBe(later.id);
    await prisma.fleetRepo.delete({ where: { id: later.id } });
    expect((await repoRepo.findAnchor(project.id))?.id).toBe(tieA.id);
  });

  it('AC-10: findAnchor returns null for a project with no fleet repo', async () => {
    const project = await prisma.project.findUniqueOrThrow({ where: { slug: emptySlug } });
    expect(await prisma.fleetRepo.count({ where: { projectId: project.id } })).toBe(0);
    expect(await repoRepo.findAnchor(project.id)).toBeNull();
  });

  it('AC-11: POST a PROJECT thread as a project DEVELOPER answers 201 with kind PROJECT', async () => {
    const res = await createProjectThread('web', { kind: 'PROJECT', title: 'Brainstorm the rollout', backend: { kind: 'native', model: 'm1' } }).expect(201);
    const thread = data<{ id: string; kind: string; title: string; createdById: string; status: string; maxCostUsd: string }>(res);
    expect(thread).toMatchObject({ kind: 'PROJECT', title: 'Brainstorm the rollout', createdById: world.ids.dev, status: 'ACTIVE', maxCostUsd: '5' });
  });

  it('AC-12: the created row has null repoId, baseRef, feature and specPath', async () => {
    const created = data<{ id: string }>(await createProjectThread('web', { kind: 'PROJECT', title: 'No repo fields', backend: { kind: 'native', model: 'm1' } }).expect(201));
    const row = await prisma.chatThread.findUniqueOrThrow({ where: { id: created.id } });
    expect(row).toMatchObject({ kind: 'PROJECT', repoId: null, baseRef: null, feature: null, specPath: null });
    // The anchor lookup is bookkeeping: it must not leak into the row (the project's oldest repo is acme/app).
    expect(row.repoId).not.toBe(world.repoId);
  });

  it('AC-13: POST a PROJECT thread in a project with no fleet repo answers 409 threads.noFleetRepo', async () => {
    const res = await createProjectThread(emptySlug, { kind: 'PROJECT', title: 'No anchor', backend: { kind: 'native', model: 'm1' } }).expect(409);
    expect(res.body.message).toBe('This project has no repository, so a project thread cannot run');
    expect(res.body.ret).not.toBe(0);
    const project = await prisma.project.findUniqueOrThrow({ where: { slug: emptySlug } });
    expect(await prisma.chatThread.count({ where: { projectId: project.id } })).toBe(0);
  });

  it('AC-14: GET the thread list returns a PROJECT thread created in that project with kind PROJECT', async () => {
    const created = data<{ id: string }>(await createProjectThread('web', { kind: 'PROJECT', title: 'Listed project thread', backend: { kind: 'native', model: 'm1' } }).expect(201));
    const res = await request(server).get('/api/projects/web/threads?size=100').set(asDev()).expect(200);
    const items = data<{ items: Array<{ id: string; kind: string }> }>(res).items;
    expect(items.find((item) => item.id === created.id)).toMatchObject({ kind: 'PROJECT' });
  });

  it('a REPO create still carries its repo, feature and spec path', async () => {
    const created = data<{ id: string; kind: string }>(await createProjectThread('web', {
      repoId: world.repoId, feature: 'project-thread-repo', title: 'Still a repo thread', backend: { kind: 'native', model: 'm1' },
    }).expect(201));
    expect(created.kind).toBe('REPO');
    expect(await prisma.chatThread.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({
      repoId: world.repoId, baseRef: 'trunk', feature: 'project-thread-repo', specPath: '.nax/features/project-thread-repo/spec.md',
    });
  });

  it('refuses a PROJECT create that also carries a feature (400 threads.input projectFields)', async () => {
    const res = await createProjectThread('web', { kind: 'PROJECT', feature: 'sneaky', title: 'Sneaky', backend: { kind: 'native', model: 'm1' } }).expect(400);
    expect(res.body.message).toBe('Invalid thread input: projectFields');
  });
});
