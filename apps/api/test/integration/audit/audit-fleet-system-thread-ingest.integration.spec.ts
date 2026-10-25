import { canRunDbTests } from '../../helpers/test-environment';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { enrollRunner, FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { putThreadLines, seedThreadJobFor } from '../../helpers/thread-fixtures';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { KnowledgeRepoIndexer } from '../../../src/fleet/knowledge/knowledge-repo-indexer';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { withTestActor, fixtureDb } from '../../helpers/action-context';

const describeDb = canRunDbTests() ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });

describeDb('US-008 system thread and knowledge audit integration (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };
  let artifactDir: string;
  const envKeys = ['FLEET_ARTIFACT_DIR', 'FLEET_THREADS_ENABLED'] as const;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const key of envKeys) saved[key] = process.env[key];
    process.env.FLEET_THREADS_ENABLED = 'true';
    artifactDir = mkdtempSync(join(tmpdir(), 'koda-audit-thread-'));
    process.env.FLEET_ARTIFACT_DIR = artifactDir;
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(server, prisma);
    runner = await enrollRunner(server, world.tokens.root, 'audit-thread-runner');
    await prisma.runner.update({ where: { id: runner.runnerId }, data: { protocolVersion: 4, lastSeenAt: new Date(), enabled: true, capacity: 1 } });
  });

  afterAll(async () => {
    try { await app?.close(); } finally {
      for (const key of envKeys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key] as string;
      }
      if (artifactDir) rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  const offsets = new Map<string, number>();
  const seed = (feature: string) => seedThreadJobFor(prisma, world, runner, { feature });
  const upload = async (s: Awaited<ReturnType<typeof seed>>, lines: object[], epoch = 1) => {
    const offset = offsets.get(s.jobId) ?? 0;
    const size = await putThreadLines(server, s.runnerKey, { id: s.jobId, leaseEpoch: epoch }, lines.map(line => JSON.stringify(line)), offset);
    offsets.set(s.jobId, size);
    return size;
  }; 
  const start = (turnId: string) => ({ type: 'turn_start', turnId });
  const end = (turnId: string, status = 'completed') => ({ type: 'turn_end', turnId, status, output: 'Done', usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0 });
  const auditRows = (threadId: string) => prisma.auditEntry.findMany({ where: { key: 'system.thread.ingest', resourceId: threadId, resourceType: 'thread' } });

  it('AC-1/7: persists thread audit context and completed assistant status despite runner request', async () => {
    const s = await seed('audit-thread-ac1');
    await upload(s, [start('t1'), end('t1')]);
    const rows = await auditRows(s.threadId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'system.thread.ingest', resourceType: 'thread', projectId: world.projectId, actorType: 'SYSTEM', actorId: 'thread', origin: 'system', summary: 'turn ended completed' });
    expect(await prisma.chatMessage.findFirstOrThrow({ where: { threadId: s.threadId, turnId: 't1', role: 'assistant' } })).toMatchObject({ status: 'complete' });
  });

  it('AC-2/3/4/15: audits each non-skipped turn end only', async () => {
    const s = await seed('audit-thread-ac234');
    await upload(s, [start('t2'), { type: 'text_delta', turnId: 't2', round: 1, text: 'hi' }]);
    expect(await auditRows(s.threadId)).toHaveLength(0);
    await upload(s, [end('t2', 'cancelled')]);
    await upload(s, [start('t4'), end('t4'), start('t5'), end('t5')]);
    await upload(s, [end('missing')]);
    const rows = await auditRows(s.threadId);
    expect(rows.map(row => row.summary)).toEqual(['turn ended cancelled', 'turn ended completed', 'turn ended completed']);
  });

  it('AC-5: audit rejection prevents completion even through line retry', async () => {
    const s = await seed('audit-thread-ac5');
    await upload(s, [start('t6')]);
    const before = await auditRows(s.threadId);
    const record = vi.spyOn(app.get(AuditRecorder), 'record').mockRejectedValue(new Error('audit down'));
    await upload(s, [end('t6')]);
    const message = await prisma.chatMessage.findFirstOrThrow({ where: { threadId: s.threadId, turnId: 't6', role: 'assistant' } });
    expect(await auditRows(s.threadId)).toHaveLength(before.length);
    expect(message.status).not.toBe('complete');
    record.mockRestore();
  });

  it('AC-6: stale lease rejects upload and adds no audit entry', async () => {
    const s = await seed('audit-thread-ac6');
    await prisma.fleetJob.update({ where: { id: s.jobId }, data: { leaseEpoch: 2 } });
    const before = await auditRows(s.threadId);
    const stale = await request(server).put(`/api/fleet/runner/jobs/${s.jobId}/logs/thread?leaseEpoch=1&offset=0`)
      .set({ Authorization: `Bearer ${s.runnerKey}`, 'content-type': 'application/octet-stream', 'x-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' }).send(Buffer.alloc(0));
    expect(stale.status).toBe(409);
    expect(await auditRows(s.threadId)).toHaveLength(before.length);
  });

  it('AC-8/9: records head-only index pass and preserves checkpoint after audit rejection', async () => {
    const repo = await prisma.fleetRepo.create({ data: { projectId: world.projectId, provider: 'github', owner: 'audit-owner', name: 'audit-repo', defaultBranch: 'main', githubInstallationId: 123n, createdById: world.ids.dev } });
    const client = app.get(PrismaService);
    const indexer = app.get(KnowledgeRepoIndexer);
    const github = (indexer as unknown as { github: { mintReadOnlyToken: ReturnType<typeof vi.fn>; getBranchHead: ReturnType<typeof vi.fn>; getTree: ReturnType<typeof vi.fn>; getFile: ReturnType<typeof vi.fn> } }).github;
    vi.spyOn(github, 'mintReadOnlyToken').mockResolvedValue({ token: 'read-token', expiresAt: new Date() });
    vi.spyOn(github, 'getBranchHead').mockResolvedValueOnce('sha-2').mockResolvedValueOnce('sha-3');
    vi.spyOn(github, 'getTree').mockResolvedValue({ entries: [{ path: 'README.md', type: 'blob', sha: 'b1', size: 10 }], truncated: false });
    const getFile = vi.spyOn(github, 'getFile');
    await withTestActor({ type: 'SYSTEM', id: 'knowledge' }, async () => {
      await client.client.knowledgeRepoIndex.create({ data: { repoId: repo.id, projectId: world.projectId, status: 'idle', indexedSha: 'sha-1', patternsKey: 'default', fileCount: 1, chunkCount: 0, unembeddedCount: 0, skippedCount: 0 } });
      await client.client.knowledgeRepoFile.create({ data: { repoId: repo.id, path: 'README.md', blobSha: 'b1', chunkCount: 0, unembeddedCount: 0 } });
    });
    const result = await withTestActor({ type: 'SYSTEM', id: 'knowledge' }, () => indexer.indexRepo(repo.id));
    expect(result.status).toBe('indexed');
    expect(getFile).not.toHaveBeenCalled();
    const knowledgeRows = await prisma.auditEntry.findMany({ where: { key: 'system.knowledge.index', resourceId: repo.id } });
    expect(knowledgeRows).toHaveLength(1);
    expect(knowledgeRows[0]).toMatchObject({ projectId: world.projectId, actorType: 'SYSTEM', actorId: 'knowledge', origin: 'system', summary: 'indexed 0 changed, 0 removed' });
    const record = vi.spyOn(app.get(AuditRecorder), 'record').mockRejectedValue(new Error('audit down'));
    const failed = await withTestActor({ type: 'SYSTEM', id: 'knowledge' }, () => indexer.indexRepo(repo.id));
    expect(failed.status).toBe('failed');
    expect((await client.client.knowledgeRepoIndex.findUniqueOrThrow({ where: { repoId: repo.id } })).indexedSha).toBe('sha-2');
    expect(await prisma.auditEntry.count({ where: { key: 'system.knowledge.index', resourceId: repo.id } })).toBe(1);
    record.mockRestore();
  });
});
