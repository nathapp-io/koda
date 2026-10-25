import { canRunDbTests } from '../../helpers/test-environment';
import request from 'supertest';
import { generateKeyPairSync } from 'crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { fixtureDb } from '../../helpers/action-context';
import { FleetHttpWorld, insertRunner, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { FakeForge, startFakeForge } from '../../helpers/fake-forge';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
const ENC_KEY = 'b'.repeat(64);
const ENV_KEYS = ['GITHUB_API_URL', 'VCS_GITLAB_API_URL', 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY_FILE', 'GITHUB_APP_SLUG', 'VCS_ENCRYPTION_KEY'] as const;

describeIntegration('fleet runner and repo audit rows (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let forge: FakeForge;
  let forgeTempDir: string;
  const saved: Record<string, string | undefined> = {};
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const tok = (who: keyof FleetHttpWorld['tokens']) => as(world.tokens[who]);
  const entries = (id: string, key: string) => prisma.auditEntry.findMany({ where: { resourceId: id, key } });
  let sequence = 0;

  beforeAll(async () => {
    forge = await startFakeForge();
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    forgeTempDir = mkdtempSync(join(tmpdir(), 'audit-fleet-gh-'));
    const keyFile = join(forgeTempDir, 'app.pem');
    writeFileSync(keyFile, privateKey.export({ type: 'pkcs1', format: 'pem' }));
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    Object.assign(process.env, { GITHUB_API_URL: forge.url, VCS_GITLAB_API_URL: `${forge.url}/api/v4`, GITHUB_APP_ID: '4242', GITHUB_APP_PRIVATE_KEY_FILE: keyFile, GITHUB_APP_SLUG: 'koda-fleet', VCS_ENCRYPTION_KEY: ENC_KEY });
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(server, prisma);
    for (const name of ['extra', 'check']) {
      forge.routes.set(`GET /repos/acme/${name}/installation`, () => ({ status: 200, body: { id: 77 } }));
      forge.routes.set(`GET /repos/acme/${name}`, () => ({ status: 200, body: { name, owner: { login: 'acme' }, default_branch: 'trunk' } }));
    }
    forge.routes.set('POST /app/installations/77/access_tokens', () => ({ status: 201, body: { token: 'ghs_fake', expires_at: '2099-01-01T00:00:00Z' } }));
  });

  afterAll(async () => {
    await app.close();
    await forge.close();
    rmSync(forgeTempDir, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  beforeEach(async () => { await prisma.auditEntry.deleteMany(); });

  it('AC-1/2/3: enrollment audit records only successful creates, and recorder failure rolls the insert back', async () => {
    const countBefore = await prisma.runnerEnrollment.count();
    const created = data<{ id: string }>(await request(server).post('/api/fleet/enrollments').set(tok('root')).send({ labels: ['secret-label'] }).expect(201));
    expect(await entries(created.id, 'fleet.enrollment.create')).toMatchObject([{ resourceType: 'fleet-enrollment', projectId: null, actorType: 'USER', actorId: world.ids.root, summary: 'created' }]);
    await request(server).post('/api/fleet/enrollments').set(tok('dev')).send({ labels: [] }).expect(403);
    expect(await prisma.auditEntry.count({ where: { key: 'fleet.enrollment.create', actorId: world.ids.dev } })).toBe(0);

    const audit = app.get(AuditRecorder);
    const entryCount = await prisma.auditEntry.count({ where: { key: 'fleet.enrollment.create' } });
    const spy = vi.spyOn(audit, 'record').mockRejectedValueOnce(new Error('audit unavailable'));
    await request(server).post('/api/fleet/enrollments').set(tok('root')).send({ labels: [] }).expect(500);
    spy.mockRestore();
    expect(await prisma.runnerEnrollment.count()).toBe(countBefore + 1);
    expect(await prisma.auditEntry.count({ where: { key: 'fleet.enrollment.create' } })).toBe(entryCount);
  });

  it('AC-4/5/6: runner updates and idle deletion are audited; busy deletion is refused without an entry', async () => {
    const target = await insertRunner(prisma, { createdById: world.ids.root });
    await request(server).patch(`/api/fleet/runners/${target.id}`).set(tok('root')).send({ enabled: false }).expect(200);
    expect(await entries(target.id, 'fleet.runner.update')).toMatchObject([{ resourceType: 'fleet-runner', projectId: null, summary: 'fields: enabled' }]);

    const idle = await insertRunner(prisma, { createdById: world.ids.root });
    await request(server).delete(`/api/fleet/runners/${idle.id}`).set(tok('root')).expect(204);
    expect(await entries(idle.id, 'fleet.runner.delete')).toMatchObject([{ summary: 'deleted' }]);

    const busy = await insertRunner(prisma, { createdById: world.ids.root });
    await prisma.fleetJob.create({ data: { projectId: world.projectId, repoId: world.repoId, runnerId: busy.id, leaseEpoch: 1, ref: 'main', command: 'RUN', feature: `audit-runner-${++sequence}`, profiles: [], maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: world.ids.root, state: 'RUNNING', firstStartedAt: new Date() } });
    await request(server).delete(`/api/fleet/runners/${busy.id}`).set(tok('root')).expect(409);
    expect(await entries(busy.id, 'fleet.runner.delete')).toHaveLength(0);
  });

  it('AC-7/8/9/10/11: repo create/delete audit, duplicate and busy refusals, and check remain unaudited', async () => {
    const createRepo = () => request(server).post('/api/fleet/repos').set(tok('root')).send({ projectSlug: 'web', provider: 'github', owner: 'acme', name: 'extra' });
    const repo = data<{ id: string }>(await createRepo().expect(201));
    expect(await entries(repo.id, 'fleet.repo.create')).toMatchObject([{ resourceType: 'fleet-repo', projectId: world.projectId, actorId: world.ids.root, summary: 'registered github' }]);
    await createRepo().expect(409);
    expect(await prisma.auditEntry.count({ where: { key: 'fleet.repo.create', projectId: world.projectId } })).toBe(1);

    const deleteMe = await prisma.fleetRepo.create({ data: { projectId: world.projectId, provider: 'github', owner: 'acme', name: 'delete-me', defaultBranch: 'main', githubInstallationId: BigInt(77), createdById: world.ids.root } });
    await request(server).delete(`/api/fleet/repos/${deleteMe.id}`).set(tok('root')).expect(204);
    expect(await entries(deleteMe.id, 'fleet.repo.delete')).toMatchObject([{ projectId: world.projectId, summary: 'deleted' }]);

    const busy = await prisma.fleetRepo.create({ data: { projectId: world.projectId, provider: 'github', owner: 'acme', name: 'busy', defaultBranch: 'main', githubInstallationId: BigInt(77), createdById: world.ids.root } });
    await prisma.fleetJob.create({ data: { projectId: world.projectId, repoId: busy.id, ref: 'main', command: 'RUN', feature: `audit-repo-${++sequence}`, profiles: [], maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: world.ids.root, state: 'QUEUED' } });
    await request(server).delete(`/api/fleet/repos/${busy.id}`).set(tok('root')).expect(409);
    expect(await entries(busy.id, 'fleet.repo.delete')).toHaveLength(0);

    const check = await prisma.fleetRepo.create({ data: { projectId: world.projectId, provider: 'github', owner: 'acme', name: 'check', defaultBranch: 'main', githubInstallationId: BigInt(77), createdById: world.ids.root } });
    await request(server).post(`/api/fleet/repos/${check.id}/check`).set(tok('root')).expect(200);
    expect(await prisma.auditEntry.findMany({ where: { resourceId: check.id } })).toHaveLength(0);
  });
});
