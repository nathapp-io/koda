import { canRunDbTests } from '../../helpers/test-environment';
/**
 * US-001 (#424): thread create and a mode change refuse (409) a thread no enabled thread-capable runner can host —
 * its kind's hosting capability, its mode's capability or its backend. The refusal names the cause, and no thread
 * row is written. A fleet with no thread-capable runner enrolled is still not judged (#399's rule).
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/thread-capability-unavailable.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { FLEET_CAPS, FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { FLEET_CFG, IFleetConfig } from '../../../src/config/fleet.config';
import { fixtureDb } from '../../helpers/action-context';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;
vi.setConfig({ testTimeout: 20_000 });

const OFFERED = 'opencode-go/deepseek-v4.1-flash';
const OTHER = 'someone/else-model';

describeIntegration('thread create and mode change refuse a thread no runner can host (PG, US-001)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let seq = 0;

  const cfg = () => app.get<IFleetConfig>(FLEET_CFG, { strict: false });
  const asDev = () => ({ Authorization: `Bearer ${world.tokens.dev}` });
  const createProject = (backend: Record<string, unknown> = { kind: 'native', model: OFFERED }) =>
    request(server).post('/api/projects/web/threads').set(asDev()).send({ kind: 'PROJECT', title: `Thread ${++seq}`, backend });
  const createRepo = (mode: string, backend: Record<string, unknown> = { kind: 'native', model: OFFERED }) =>
    request(server).post('/api/projects/web/threads').set(asDev()).send({ repoId: world.repoId, feature: `repo-${++seq}`, title: 'Repo thread', mode, backend });
  const createWorkspace = (backend: Record<string, unknown> = { kind: 'native', model: OFFERED }) =>
    request(server).post('/api/threads').set(asDev()).send({ title: `Workspace ${++seq}`, backend });

  /** A protocol-4 runner whose thread capabilities the case chooses. */
  const threadRunner = (over: {
    enabled?: boolean; protocolVersion?: number; native?: string[];
    projectThreads?: boolean; workspaceThreads?: boolean; threadModes?: boolean;
  } = {}) => prisma.runner.create({ data: {
    name: `cap-runner-${++seq}`, apiKeyHash: `cap-runner-hash-${seq}`, os: 'linux', arch: 'x64', labels: ['linux'], capacity: 1,
    capabilities: {
      ...FLEET_CAPS,
      ...(over.projectThreads !== undefined ? { projectThreads: over.projectThreads } : {}),
      ...(over.workspaceThreads !== undefined ? { workspaceThreads: over.workspaceThreads } : {}),
      ...(over.threadModes !== undefined ? { threadModes: over.threadModes } : {}),
      threadBackends: { native: over.native ?? [OFFERED], acp: [] },
    } as unknown as Prisma.InputJsonValue,
    daemonVersion: '0.1.0', protocolVersion: over.protocolVersion ?? 4, bootId: `cap-boot-${seq}`, enabled: over.enabled ?? true,
    lastSeenAt: new Date(), createdById: world.ids.root,
  } });
  const clearRunners = () => prisma.runner.deleteMany({ where: { name: { startsWith: 'cap-runner-' } } });

  /** A REPO thread owned by the developer, so the mode route's key check passes. */
  const makeThread = async (runnerId: string | null) => prisma.chatThread.create({ data: {
    kind: 'REPO', projectId: world.projectId, repoId: world.repoId, baseRef: 'trunk', feature: `mode-${++seq}`,
    specPath: 'spec.md', title: 'Mode thread', backend: { kind: 'native', model: OFFERED }, skills: [],
    createdById: world.ids.dev, createdByType: 'USER', mode: 'read', runnerId,
  } });
  const patchMode = (id: string, mode: string) =>
    request(server).patch(`/api/projects/web/threads/${id}/mode`).set(asDev()).send({ mode });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(server, prisma);
    cfg().threadsEnabled = true;
    // The developer role holds `thread.mode.ask` but not `thread.mode.full`; this case needs the full mode.
    await grantKeys(prisma, { type: 'USER', id: world.ids.dev }, ['thread.mode.full'], world.projectId);
    await app.get(PermissionCache).invalidate();
  }, 30_000);

  afterEach(async () => { await clearRunners(); });
  afterAll(async () => { await app?.close(); });

  it('AC-9: refuses a PROJECT thread no runner can host, and writes no thread', async () => {
    await threadRunner({ native: [OFFERED] });
    const before = await prisma.chatThread.count();
    const res = await createProject().expect(409);
    expect(res.body.message).toBe('No enabled runner can host a project thread, so this thread could never run');
    expect(await prisma.chatThread.count()).toBe(before);
  });

  it('AC-9 control: a PROJECT thread is accepted when a runner advertises projectThreads', async () => {
    await threadRunner({ native: [OFFERED], projectThreads: true });
    await createProject().expect(201);
  });

  it('AC-10: refuses a WORKSPACE thread no runner can host, and writes no thread', async () => {
    await threadRunner({ native: [OFFERED] });
    const before = await prisma.chatThread.count();
    const res = await createWorkspace().expect(409);
    expect(res.body.message).toBe('No enabled runner can host a workspace thread, so this thread could never run');
    expect(await prisma.chatThread.count()).toBe(before);
  });

  it('AC-10 control: a WORKSPACE thread is accepted when a runner advertises workspaceThreads', async () => {
    await threadRunner({ native: [OFFERED], workspaceThreads: true });
    await createWorkspace().expect(201);
  });

  it('AC-11: refuses a REPO thread in mode ask no runner can host, and writes no thread', async () => {
    await threadRunner({ native: [OFFERED] });
    const before = await prisma.chatThread.count();
    const res = await createRepo('ask').expect(409);
    expect(res.body.message).toBe('No enabled runner can host threads in mode ask, so this thread could never run');
    expect(await prisma.chatThread.count()).toBe(before);
  });

  it('AC-11 control: a REPO thread in mode ask is accepted when a runner advertises threadModes', async () => {
    await threadRunner({ native: [OFFERED], threadModes: true });
    await createRepo('ask').expect(201);
  });

  it('AC-12: answers the backend refusal when the mode-capable runner does not offer the backend', async () => {
    // One runner offers the backend but no mode, the other the mode but not the backend: the furthest misfit wins.
    await threadRunner({ native: [OFFERED] });
    await threadRunner({ native: [OTHER], threadModes: true });
    const before = await prisma.chatThread.count();
    const res = await createRepo('full').expect(409);
    expect(res.body.message).toBe(`No enabled runner offers ${OFFERED} (backend.model), so this thread could never run`);
    expect(await prisma.chatThread.count()).toBe(before);
  });

  it('AC-13: with no thread-capable runner enrolled, a PROJECT thread is not judged', async () => {
    await threadRunner({ protocolVersion: 1, native: [] });
    await createProject().expect(201);
  });

  it('AC-14: refuses a mode change the thread\'s own runner cannot host, and stores no mode', async () => {
    const own = await threadRunner({ native: [OFFERED] });
    // Another enabled runner could host the mode, but the thread is pinned to its own runner.
    await threadRunner({ native: [OFFERED], threadModes: true });
    const row = await makeThread(own.id);
    const res = await patchMode(row.id, 'ask').expect(409);
    expect(res.body.message).toBe('No enabled runner can host threads in mode ask, so this thread could never run');
    expect((await prisma.chatThread.findUniqueOrThrow({ where: { id: row.id } })).mode).toBe('read');
  });

  it('AC-15: a mode change judges the mode rule alone, so a lost backend does not refuse it', async () => {
    const own = await threadRunner({ native: [OTHER], threadModes: true });
    const row = await makeThread(own.id);
    await patchMode(row.id, 'ask').expect(200);
    expect((await prisma.chatThread.findUniqueOrThrow({ where: { id: row.id } })).mode).toBe('ask');
  });
});
