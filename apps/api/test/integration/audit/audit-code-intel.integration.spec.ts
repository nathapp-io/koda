import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { MembershipService } from '../../../src/permissions/membership.service';
import { asTestActor, fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';
import { FanOutPublisher } from '../../../src/outbox/fan-out-publisher';
import { outboxRecord } from '../../helpers/outbox-record';
import { encryptToken } from '../../../src/common/utils/encryption.util';

const vcsMock = vi.hoisted(() => ({ fetchCommitFiles: vi.fn() }));
vi.mock('../../../src/vcs/factory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/vcs/factory')>();
  return { ...actual, createVcsProvider: vi.fn(() => vcsMock) };
});

const describeIntegration = canRunDbTests() ? describe : describe.skip;
const SLUG = 'audit-code-intel';
const REPO = 'acme/widgets';

describeIntegration('code-intel indexing audit (real AppModule)', () => {
  vi.setConfig({ testTimeout: 120_000 });
  let app: NathApplication;
  let db: PrismaClient;
  let server: Parameters<typeof request>[0];
  let projectId: string;
  let rootUserId: string;
  let rootToken: string;
  let viewerToken: string;
  let restoreRecord: (() => void) | undefined;
  const originalEncryptionKey = process.env.VCS_ENCRYPTION_KEY;
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const postIndex = (token: string, repoId: string, commitHash: string, files: Array<{path: string; content: string}>) =>
    request(server).post('/api/code-intel/index').set(auth(token)).send({ repoId, commitHash, projectSlug: SLUG, files });
  const auditCount = (repoId: string) => db.auditEntry.count({ where: { key: 'codeintel.index.write', resourceId: repoId } });
  const symbols = (q: string) => request(server).get(`/api/code-intel/symbols?projectSlug=${SLUG}&q=${q}`).set(auth(rootToken));

  beforeAll(async () => {
    await resetDb();
    process.env.VCS_ENCRYPTION_KEY = 'ab'.repeat(32);
    app = await bootHttpApp({ registrationEnabled: true });
    server = app.getHttpServer();
    db = fixtureDb(app);
    const root = await request(server).post('/api/auth/register').send({
      email: 'audit-code-intel-root@koda.test', name: 'Root', password: TEST_PASSWORD,
    }).expect(201);
    rootToken = data<{ accessToken: string }>(root).accessToken;
    rootUserId = (await db.user.findUniqueOrThrow({ where: { email: 'audit-code-intel-root@koda.test' }, select: { id: true } })).id;
    await request(server).post('/api/projects').set(auth(rootToken)).send({ name: 'Code Intel Audit', slug: SLUG, key: 'CIA' }).expect(201);
    projectId = (await db.project.findUniqueOrThrow({ where: { slug: SLUG }, select: { id: true } })).id;
    await db.vcsConnection.create({ data: {
      projectId, provider: 'github', repoOwner: 'acme', repoName: 'app',
      encryptedToken: encryptToken('test-token', process.env.VCS_ENCRYPTION_KEY as string),
      syncMode: 'webhook',
    } });

    await request(server).post('/api/admin/users').set(auth(rootToken)).send({
      email: 'audit-code-intel-viewer@koda.test', name: 'Viewer', password: TEST_PASSWORD, role: 'MEMBER',
    }).expect(201);
    viewerToken = await loginToken(server, 'audit-code-intel-viewer@koda.test');
    const viewer = await db.user.findUniqueOrThrow({ where: { email: 'audit-code-intel-viewer@koda.test' }, select: { id: true } });
    const membership = asTestActor(app.get(MembershipService), { type: 'SYSTEM', id: 'seed' });
    await membership.createBinding(
      { principal: { type: 'USER', id: viewer.id }, roleKey: 'viewer', projectId },
      { type: 'SYSTEM', id: 'integration-test' },
    );
  });

  afterEach(() => {
    restoreRecord?.();
    restoreRecord = undefined;
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await app?.close();
    if (originalEncryptionKey === undefined) delete process.env.VCS_ENCRYPTION_KEY;
    else process.env.VCS_ENCRYPTION_KEY = originalEncryptionKey;
  });

  it('AC-1/2/3: REST index writes one safe USER/rest audit entry', async () => {
    const response = await postIndex(rootToken, REPO, 'c1', [{ path: 'src/private.ts', content: 'export function alpha(): number { return 1; }' }]).expect(201);
    const result = data<{ symbolsIndexed: number; filesIndexed: number }>(response);
    const rows = await db.auditEntry.findMany({ where: { key: 'codeintel.index.write', resourceId: REPO } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ resourceType: 'code-repo', projectId, actorType: 'USER', actorId: rootUserId, origin: 'rest' });
    expect(rows[0].summary).toBe(`indexed ${result.symbolsIndexed} symbols in 1 files`);
    expect(rows[0].summary).not.toMatch(/src\/private\.ts|alpha|c1/);
  });

  it('AC-4/5/6: record failure rolls back replacement and preserves old symbol', async () => {
    await postIndex(rootToken, REPO, 'rollback-before', [{ path: 'src/private.ts', content: 'export function alpha(): number { return 1; }' }]).expect(201);
    const recorder = app.get(AuditRecorder);
    const spy = vi.spyOn(recorder, 'record').mockRejectedValue(new Error('audit down'));
    restoreRecord = () => spy.mockRestore();
    const failed = await postIndex(rootToken, REPO, 'rollback-after', [{ path: 'src/private.ts', content: 'export function beta(): number { return 2; }' }]);
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(data<{ items: unknown[] }>(await symbols('alpha').expect(200)).items).toHaveLength(1);
    expect(data<{ items: unknown[] }>(await symbols('beta').expect(200)).items).toHaveLength(0);
  });

  it('AC-7/8: viewer refusal writes no audit entry', async () => {
    const before = await auditCount(REPO);
    await postIndex(viewerToken, REPO, 'viewer-denied', [{ path: 'src/denied.ts', content: 'export function denied() {}' }]).expect(403);
    expect(await auditCount(REPO)).toBe(before);
  });

  it('AC-16/17/18: push commit indexes symbols and records SYSTEM/codeintel once', async () => {
    vcsMock.fetchCommitFiles.mockResolvedValue([{ path: 'src/push.ts', content: 'export function pushedFn() { return 1; }' }]);
    const payload = { repoId: 'acme/app', commitHash: 'p1', projectId, changedFiles: ['src/push.ts'], removedFiles: [] };
    const id = 'audit-codeintel-push-success';
    await db.outboxEvent.create({ data: { id, projectId, type: 'code_commit', eventId: id, payload: JSON.stringify(payload) } });
    await app.get(FanOutPublisher).publish(outboxRecord('code_commit', payload, { id }));
    const rows = await db.auditEntry.findMany({ where: { key: 'system.codeintel.index-commit', resourceId: 'acme/app' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ projectId, resourceType: 'code-repo', actorType: 'SYSTEM', actorId: 'codeintel', origin: 'system', summary: 'indexed 1 symbols in 1 files' });
    expect(data<{ items: Array<{ name: string }> }>(await symbols('pushedFn').expect(200)).items.map(({ name }) => name)).toContain('pushedFn');
  });

  it('AC-19/20/21: push audit failure rolls back symbols and persists outbox lastError', async () => {
    vcsMock.fetchCommitFiles.mockResolvedValue([{ path: 'src/push2.ts', content: 'export function pushedTwo() { return 2; }' }]);
    const payload = { repoId: 'acme/app', commitHash: 'p2', projectId, changedFiles: ['src/push2.ts'], removedFiles: [] };
    const id = 'audit-codeintel-push-failure';
    await db.outboxEvent.create({ data: { id, projectId, type: 'code_commit', eventId: id, payload: JSON.stringify(payload) } });
    const recorder = app.get(AuditRecorder);
    const spy = vi.spyOn(recorder, 'record').mockRejectedValue(new Error('audit down'));
    restoreRecord = () => spy.mockRestore();
    await expect(app.get(FanOutPublisher).publish(outboxRecord('code_commit', payload, { id }))).rejects.toThrow('audit down');
    expect(await db.symbol.count({ where: { projectId, repoId: 'acme/app', commitHash: 'p2' } })).toBe(0);
    expect(data<{ items: unknown[] }>(await symbols('pushedTwo').expect(200)).items).toEqual([]);
    expect((await db.outboxEvent.findUniqueOrThrow({ where: { id } })).lastError).toContain('audit down');
  });

  it('AC-22/23/24: empty file input returns zero counts and records no write', async () => {
    const before = await auditCount(REPO);
    const response = await postIndex(rootToken, REPO, 'empty', []).expect(201);
    expect(data<{ symbolsIndexed: number; filesIndexed: number }>(response)).toMatchObject({ symbolsIndexed: 0, filesIndexed: 0 });
    expect(await auditCount(REPO)).toBe(before);
    expect(await db.symbol.count({ where: { projectId, repoId: REPO, commitHash: 'empty' } })).toBe(0);
  });
});
