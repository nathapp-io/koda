import { canRunDbTests } from '../../helpers/test-environment';
/**
 * #436 (PG): a message on an existing thread whose backend no enabled thread-capable runner offers any more is refused
 * with the same 409 `threads.backendUnavailable` thread create uses, before anything is written. Both send routes
 * (project/repo and workspace) are covered. A retry of an already-accepted message (same clientMessageId) still returns
 * the original message; with no thread-capable runner enrolled at all, the send is not judged.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/thread-message-backend-unavailable.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FLEET_CAPS, FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { FLEET_CFG, IFleetConfig } from '../../../src/config/fleet.config';
import { fixtureDb } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;
vi.setConfig({ testTimeout: 20_000 });

const OFFERED = 'opencode-go/deepseek-v4.1-flash';
const OTHER = 'someone/else';
const REFUSAL = `No enabled runner offers ${OFFERED} (backend.model), so this thread could never run`;

describeIntegration('thread message refuses a backend no runner offers any more (PG, #436)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let seq = 0;

  const cfg = () => app.get<IFleetConfig>(FLEET_CFG, { strict: false });
  const asDev = () => ({ Authorization: `Bearer ${world.tokens.dev}` });
  const threadRunner = (over: { enabled?: boolean; protocolVersion?: number; native?: string[] } = {}) =>
    prisma.runner.create({ data: {
      name: `msg-runner-${++seq}`, apiKeyHash: `msg-runner-hash-${seq}`, os: 'linux', arch: 'x64', labels: ['linux'], capacity: 1,
      capabilities: { ...FLEET_CAPS, projectThreads: true, workspaceThreads: true, threadBackends: { native: over.native ?? [OFFERED], acp: ['claude'] } } as object,
      daemonVersion: '0.1.0', protocolVersion: over.protocolVersion ?? 4, bootId: `msg-boot-${seq}`, enabled: over.enabled ?? true,
      lastSeenAt: new Date(), createdById: world.ids.root,
    } });
  const clearRunners = () => prisma.runner.deleteMany({ where: { name: { startsWith: 'msg-runner-' } } });

  const createProjectThread = async (): Promise<string> =>
    data<{ id: string }>(await request(server).post('/api/projects/web/threads').set(asDev())
      .send({ kind: 'PROJECT', title: `Thread ${++seq}`, backend: { kind: 'native', model: OFFERED } }).expect(201)).id;
  const createWorkspaceThread = async (): Promise<string> =>
    data<{ id: string }>(await request(server).post('/api/threads').set(asDev())
      .send({ title: `Workspace ${++seq}`, backend: { kind: 'native', model: OFFERED } }).expect(201)).id;

  const sendProject = (id: string, clientMessageId: string) =>
    request(server).post(`/api/projects/web/threads/${id}/messages`).set(asDev()).send({ text: 'hello', clientMessageId });
  const sendWorkspace = (id: string, clientMessageId: string) =>
    request(server).post(`/api/threads/${id}/messages`).set(asDev()).send({ text: 'hello', clientMessageId });

  const writes = async (threadId: string) => ({
    messages: await prisma.chatMessage.count({ where: { threadId } }),
    jobs: await prisma.fleetJob.count({ where: { threadId } }),
  });

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

  const surfaces = [
    { name: 'project thread', create: createProjectThread, send: sendProject },
    { name: 'workspace thread', create: createWorkspaceThread, send: sendWorkspace },
  ];

  describe.each(surfaces)('$name', ({ create, send }) => {
    it('refuses a message once no runner offers the backend, and writes no message and no job', async () => {
      await threadRunner();
      const id = await create();
      await clearRunners();
      await threadRunner({ native: [OTHER] });
      const before = await writes(id);
      const res = await send(id, `cm-${++seq}`).expect(409);
      expect(res.body.message).toBe(REFUSAL);
      expect(await writes(id)).toEqual(before);
    });

    it('refuses when the only runner that offered the backend is disabled', async () => {
      await threadRunner();
      const id = await create();
      await clearRunners();
      await threadRunner({ enabled: false });
      await threadRunner({ native: [OTHER] });
      await send(id, `cm-${++seq}`).expect(409);
    });

    it('sends while a runner still offers the backend', async () => {
      await threadRunner();
      const id = await create();
      await send(id, `cm-${++seq}`).expect(201);
    });

    it('a retry of an accepted message returns the original message, not the 409', async () => {
      await threadRunner();
      const id = await create();
      const clientMessageId = `cm-${++seq}`;
      const first = await send(id, clientMessageId).expect(201);
      await clearRunners();
      await threadRunner({ native: [OTHER] });
      const retry = await send(id, clientMessageId).expect(200);
      expect(data<{ message: { id: string } }>(retry).message.id).toBe(data<{ message: { id: string } }>(first).message.id);
    });

    it('with no thread-capable runner enrolled (only a protocol-1 runner), the send is not judged', async () => {
      await threadRunner();
      const id = await create();
      await clearRunners();
      await threadRunner({ protocolVersion: 1, native: [] });
      await send(id, `cm-${++seq}`).expect(201);
    });
  });
});
