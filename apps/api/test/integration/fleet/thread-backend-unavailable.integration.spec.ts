import { canRunDbTests } from '../../helpers/test-environment';
/**
 * #399 (PG): thread create refuses a backend that no enabled thread-capable runner advertises, so a thread can no longer
 * queue its first turn forever with no reason. The refusal is 409 `threads.backendUnavailable` naming the field and the
 * value. An offline but enabled runner still counts; a disabled one does not; with no thread-capable runner enrolled at
 * all, create is not judged.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/thread-backend-unavailable.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { FLEET_CAPS, FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { FLEET_CFG, IFleetConfig } from '../../../src/config/fleet.config';
import { fixtureDb } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;
vi.setConfig({ testTimeout: 20_000 });

const OFFERED = 'opencode-go/deepseek-v4.1-flash';
const NOT_OFFERED = 'deepseek/deepseek-v4.1-flash-1017';

describeIntegration('thread create refuses a backend no runner offers (PG, #399)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let seq = 0;

  const cfg = () => app.get<IFleetConfig>(FLEET_CFG, { strict: false });
  const asDev = () => ({ Authorization: `Bearer ${world.tokens.dev}` });
  const createThread = (backend: Record<string, unknown>) =>
    request(server).post('/api/projects/web/threads').set(asDev()).send({ kind: 'PROJECT', title: `Thread ${++seq}`, backend });
  const threadRunner = (over: { enabled?: boolean; lastSeenAt?: Date; protocolVersion?: number; native?: string[]; acp?: string[] } = {}) =>
    prisma.runner.create({ data: {
      name: `backend-runner-${++seq}`, apiKeyHash: `backend-runner-hash-${seq}`, os: 'linux', arch: 'x64', labels: ['linux'], capacity: 1,
      capabilities: { ...FLEET_CAPS, projectThreads: true, workspaceThreads: true, threadBackends: { native: over.native ?? [OFFERED], acp: over.acp ?? ['claude'] } } as object,
      daemonVersion: '0.1.0', protocolVersion: over.protocolVersion ?? 4, bootId: `backend-boot-${seq}`, enabled: over.enabled ?? true,
      lastSeenAt: over.lastSeenAt ?? new Date(), createdById: world.ids.root,
    } });
  const clearRunners = () => prisma.runner.deleteMany({ where: { name: { startsWith: 'backend-runner-' } } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(server, prisma);
    cfg().threadsEnabled = true;
  }, 30_000);

  afterEach(async () => { await clearRunners(); });
  afterAll(async () => { await app?.close(); });

  it('creates a thread on a native model an online runner offers', async () => {
    await threadRunner();
    await createThread({ kind: 'native', model: OFFERED }).expect(201);
  });

  it('refuses a native model no runner offers with 409 naming backend.model, and writes no thread', async () => {
    await threadRunner();
    const before = await prisma.chatThread.count();
    const res = await createThread({ kind: 'native', model: NOT_OFFERED }).expect(409);
    expect(res.body.message).toBe(`No enabled runner offers ${NOT_OFFERED} (backend.model), so this thread could never run`);
    expect(await prisma.chatThread.count()).toBe(before);
  });

  it('refuses an ACP agent no runner offers, naming backend.agent', async () => {
    await threadRunner({ acp: ['claude'] });
    const res = await createThread({ kind: 'acp', agent: 'cursor' }).expect(409);
    expect(res.body.message).toBe('No enabled runner offers cursor (backend.agent), so this thread could never run');
  });

  it('an offline but enabled runner still counts', async () => {
    await threadRunner({ lastSeenAt: new Date(Date.now() - 86_400_000) });
    await createThread({ kind: 'native', model: OFFERED }).expect(201);
  });

  it('a disabled runner offering the model does not count while an enabled one does not offer it', async () => {
    await threadRunner({ enabled: false });
    await threadRunner({ native: ['someone/else'] });
    await createThread({ kind: 'native', model: OFFERED }).expect(409);
  });

  it('a REPO thread is refused the same way, and no thread row is written', async () => {
    await threadRunner();
    const before = await prisma.chatThread.count();
    const res = await request(server).post('/api/projects/web/threads').set(asDev())
      .send({ repoId: world.repoId, feature: `repo-${++seq}`, title: 'Repo thread', backend: { kind: 'native', model: NOT_OFFERED } }).expect(409);
    expect(res.body.message).toBe(`No enabled runner offers ${NOT_OFFERED} (backend.model), so this thread could never run`);
    expect(await prisma.chatThread.count()).toBe(before);
  });

  it('a WORKSPACE thread is refused the same way', async () => {
    await threadRunner();
    const res = await request(server).post('/api/threads').set(asDev()).send({ title: 'Workspace', backend: { kind: 'native', model: NOT_OFFERED } }).expect(409);
    expect(res.body.message).toBe(`No enabled runner offers ${NOT_OFFERED} (backend.model), so this thread could never run`);
    await request(server).post('/api/threads').set(asDev()).send({ title: 'Workspace ok', backend: { kind: 'native', model: OFFERED } }).expect(201);
  });

  it('with no thread-capable runner enrolled (only a protocol-1 runner), create is not judged', async () => {
    await threadRunner({ protocolVersion: 1, native: [] });
    await createThread({ kind: 'native', model: NOT_OFFERED }).expect(201);
  });
});
