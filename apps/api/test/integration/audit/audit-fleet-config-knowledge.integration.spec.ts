import { canRunDbTests } from '../../helpers/test-environment';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { FLEET_CFG, IFleetConfig } from '../../../src/config/fleet.config';
import { KnowledgeIndexQueue } from '../../../src/fleet/knowledge/knowledge-index.queue';
import { FLEET_REPO_FILES_READER, FleetRepoFilesReader } from '../../../src/fleet/repo-config/fleet-repo-files.reader';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';
import { fixtureDb } from '../../helpers/action-context';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
const HEAD = 'c'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
describeIntegration('fleet config and knowledge audit rows (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let world: FleetHttpWorld;
  let previousIndexSetting: boolean;
  const auth = (who: keyof FleetHttpWorld['tokens']) => ({ Authorization: `Bearer ${world.tokens[who]}` });
  const repoPath = () => `/api/projects/web/fleet/repos/${world.repoId}`;
  const knowledgePath = () => '/api/projects/web/knowledge';
  const entries = (resourceId: string, key: string) => db.auditEntry.findMany({ where: { resourceId, key } });
  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server, db);
    const reader = app.get<FleetRepoFilesReader>(FLEET_REPO_FILES_READER) as unknown as FleetRepoFilesReader;
    vi.spyOn(reader, 'list').mockImplementation(async (repo) => ({ baseSha: HEAD, defaultBranch: repo.defaultBranch, files: [] }));
    vi.spyOn(reader, 'read').mockImplementation(async (_repo, path) => ({ path, blobSha: BASE_SHA, content: '# current' }));
    vi.spyOn(app.get(KnowledgeIndexQueue), 'enqueue').mockImplementation(() => undefined);
    const cfg = app.get<IFleetConfig>(FLEET_CFG, { strict: false });
    previousIndexSetting = cfg.knowledgeIndexEnabled;
    cfg.knowledgeIndexEnabled = true;
  }, 60_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    if (app) {
      app.get<IFleetConfig>(FLEET_CFG, { strict: false }).knowledgeIndexEnabled = previousIndexSetting;
      await app.close();
    }
  });

  beforeEach(async () => {
    await db.auditEntry.deleteMany();
    await db.fleetJob.updateMany({ where: { repoId: world.repoId, feature: 'nax-config', state: { in: ['QUEUED', 'ASSIGNED', 'RUNNING'] } }, data: { state: 'CANCELLED' } });
  });

  it('AC-1/2: config edit persists one safe, correctly scoped audit entry', async () => {
    const response = await request(server).post(`${repoPath()}/config-edits`).set(auth('root')).send({
      baseSha: HEAD, prTitle: 'secret-title', edits: [{ path: '.nax/context.md', op: 'put', content: '# changed', baseSha: BASE_SHA }],
    }).expect(201);
    const jobId = data<{ job: { id: string } }>(response).job.id;
    const rows = await entries(jobId, 'fleet.job.config.edit');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'fleet.job.config.edit', resourceType: 'fleet-job', resourceId: jobId, projectId: world.projectId, actorType: 'USER', summary: `edit on repo ${world.repoId}` });
    expect(rows[0].summary).not.toContain('secret-title');
  });

  it('AC-3: regenerate is audited with its mode summary', async () => {
    const response = await request(server).post(`${repoPath()}/config-edits/regenerate`).set(auth('root')).send({ prTitle: 'regenerate title' }).expect(201);
    const jobId = data<{ job: { id: string } }>(response).job.id;
    const rows = await entries(jobId, 'fleet.job.config.edit');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ resourceType: 'fleet-job', projectId: world.projectId, summary: `regenerate on repo ${world.repoId}` });
  });

  it('AC-4/5/6: drift writes the dev entry, active-job refusal and viewer refusal add none', async () => {
    const response = await request(server).post(`${repoPath()}/drift-checks`).set(auth('dev')).expect(201);
    const jobId = data<{ job: { id: string } }>(response).job.id;
    const rows = await entries(jobId, 'fleet.repo.drift.check');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'fleet.repo.drift.check', resourceType: 'fleet-job', projectId: world.projectId, actorId: world.ids.dev, summary: `drift on repo ${world.repoId}` });
    const before = await db.auditEntry.count({ where: { key: 'fleet.repo.drift.check', projectId: world.projectId } });
    await request(server).post(`${repoPath()}/drift-checks`).set(auth('dev')).expect(409);
    expect(await db.auditEntry.count({ where: { key: 'fleet.repo.drift.check', projectId: world.projectId } })).toBe(before);
    await request(server).post(`${repoPath()}/drift-checks`).set(auth('viewer')).expect(403);
    expect(await db.auditEntry.count({ where: { key: 'fleet.repo.drift.check', actorId: world.ids.viewer } })).toBe(0);
  });

  it('AC-7/8/9/10: patterns saves audit custom/default, refuses dev and rolls back on audit failure', async () => {
    const route = `${knowledgePath()}/patterns`;
    await request(server).put(route).set(auth('root')).send({ patterns: ['secret/**/*.md'] }).expect(200);
    let rows = await entries(world.projectId, 'fleet.knowledge.patterns.update');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ resourceType: 'project', projectId: world.projectId, summary: 'custom patterns' });
    await db.auditEntry.deleteMany();
    await request(server).put(route).set(auth('root')).send({ patterns: null }).expect(200);
    rows = await entries(world.projectId, 'fleet.knowledge.patterns.update');
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toBe('default patterns');
    await db.auditEntry.deleteMany();
    await request(server).put(route).set(auth('dev')).send({ patterns: ['secret/**/*.md'] }).expect(403);
    expect(await entries(world.projectId, 'fleet.knowledge.patterns.update')).toHaveLength(0);
    const prior = await db.knowledgeProjectPatterns.findUnique({ where: { projectId: world.projectId } });
    const audit = app.get(AuditRecorder);
    const reject = vi.spyOn(audit, 'record').mockRejectedValueOnce(new Error('audit write failed'));
    await request(server).put(route).set(auth('root')).send({ patterns: ['changed/**/*.md'] }).expect(500);
    reject.mockRestore();
    expect(await db.knowledgeProjectPatterns.findUnique({ where: { projectId: world.projectId } })).toEqual(prior);
    expect(await entries(world.projectId, 'fleet.knowledge.patterns.update')).toHaveLength(0);
  });

  it('AC-11/12: reindex audits before enqueue and disabled reindex leaves neither', async () => {
    const queue = app.get(KnowledgeIndexQueue);
    const enqueue = vi.spyOn(queue, 'enqueue').mockImplementation(() => undefined);
    await request(server).post(`${knowledgePath()}/repos/${world.repoId}/reindex`).set(auth('dev')).expect(202);
    const rows = await entries(world.repoId, 'fleet.knowledge.repo.reindex');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'fleet.knowledge.repo.reindex', resourceType: 'fleet-repo', projectId: world.projectId, summary: 'reindex queued' });
    expect(enqueue).toHaveBeenCalledWith(world.repoId, 'admin');
    await db.auditEntry.deleteMany();
    enqueue.mockClear();
    const disabledRepo = await db.fleetRepo.create({
      data: { projectId: world.projectId, provider: 'github', owner: 'acme', name: 'disabled-reindex', defaultBranch: 'trunk', createdById: world.ids.root },
    });
    app.get<IFleetConfig>(FLEET_CFG, { strict: false }).knowledgeIndexEnabled = false;
    await request(server).post(`${knowledgePath()}/repos/${disabledRepo.id}/reindex`).set(auth('dev')).expect(409);
    expect(await entries(disabledRepo.id, 'fleet.knowledge.repo.reindex')).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
    app.get<IFleetConfig>(FLEET_CFG, { strict: false }).knowledgeIndexEnabled = true;
    enqueue.mockRestore();
  });
});
