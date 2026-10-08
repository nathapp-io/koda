/**
 * Fleet S3 §4 — .nax reads through the forge, config job submission, permissions (PG + fake GitHub).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-repo-config-api.integration.spec.ts
 */
import request from 'supertest';
import { generateKeyPairSync } from 'crypto';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FakeForge, startFakeForge } from '../../helpers/fake-forge';
import { FLEET_CAPS, FleetHttpWorld, insertRunner, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const ENV_KEYS = ['GITHUB_API_URL', 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY_FILE', 'GITHUB_APP_SLUG'] as const;
const HEAD = 'c'.repeat(40);
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describeIntegration('fleet repo config API (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let forge: FakeForge;
  let world: FleetHttpWorld;
  const saved: Record<string, string | undefined> = {};
  const auth = (who: keyof FleetHttpWorld['tokens']) => ({ Authorization: `Bearer ${world.tokens[who]}` });
  const base = () => `/api/projects/web/fleet/repos/${world.repoId}`;
  const edit = { baseSha: HEAD, prTitle: 'Tighten testing rule', edits: [{ path: '.nax/rules/testing.md', op: 'put', content: '# Testing\n', baseSha: 'b'.repeat(40) }] };

  beforeAll(async () => {
    forge = await startFakeForge();
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const keyFile = join(mkdtempSync(join(tmpdir(), 'gh-app-')), 'app.pem');
    writeFileSync(keyFile, privateKey.export({ type: 'pkcs1', format: 'pem' }));
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    Object.assign(process.env, { GITHUB_API_URL: forge.url, GITHUB_APP_ID: '4242', GITHUB_APP_PRIVATE_KEY_FILE: keyFile, GITHUB_APP_SLUG: 'koda-fleet' });
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
  });
  beforeEach(() => {
    forge.routes.clear();
    forge.routes.set('POST /app/installations/77/access_tokens', () => ({ status: 201, body: { token: 'ghs_1', expires_at: '2099-01-01T00:00:00Z' } }));
    forge.routes.set('GET /repos/acme/app/git/ref/heads/trunk', () => ({ status: 200, body: { object: { sha: HEAD } } }));
    forge.routes.set(`GET /repos/acme/app/git/trees/${HEAD}`, () => ({ status: 200, body: { truncated: false, tree: [{ path: '.nax', type: 'tree', sha: 'naxTree' }] } }));
    forge.routes.set('GET /repos/acme/app/git/trees/naxTree', () => ({
      status: 200,
      body: { truncated: false, tree: [
        { path: 'context.md', type: 'blob', sha: 'k'.repeat(40), size: 9 },
        { path: 'rules/testing.md', type: 'blob', sha: 'b'.repeat(40), size: 4 },
        { path: 'profiles/fast.env', type: 'blob', sha: 'e'.repeat(40), size: 4 },
        { path: 'features/x/prd.json', type: 'blob', sha: 'f'.repeat(40), size: 2 },
      ] },
    }));
    forge.routes.set('GET /repos/acme/app/contents/.nax/context.md', () => ({ status: 200, body: { type: 'file', sha: 'k'.repeat(40), size: 9, encoding: 'base64', content: b64('# Context') } }));
  });
  afterAll(async () => {
    await app.close();
    await forge.close();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('lets a VIEWER list the allowlisted files at the default-branch head (no .env, no feature files)', async () => {
    const list = data<{ baseSha: string; files: Array<{ path: string; group: string }> }>(await request(server).get(`${base()}/nax-files`).set(auth('viewer')).expect(200));
    expect(list.baseSha).toBe(HEAD);
    expect(list.files.map((f) => [f.path, f.group])).toEqual([['.nax/rules/testing.md', 'rules'], ['.nax/context.md', 'context']]);
  });

  it('reads one file for a VIEWER and refuses a non-allowlisted path with 400', async () => {
    const file = data<{ content: string; blobSha: string }>(
      await request(server).get(`${base()}/nax-files/content`).query({ path: '.nax/context.md', ref: HEAD }).set(auth('viewer')).expect(200),
    );
    expect(file).toEqual({ path: '.nax/context.md', blobSha: 'k'.repeat(40), content: '# Context' });
    await request(server).get(`${base()}/nax-files/content`).query({ path: '.nax/profiles/fast.env' }).set(auth('viewer')).expect(400);
  });

  it('answers 403 for an outsider and 404 for a repo of another project', async () => {
    await request(server).get(`${base()}/nax-files`).set(auth('outsider')).expect(403);
    await request(server).get(`/api/projects/web/fleet/repos/${world.foreignRepoId}/nax-files`).set(auth('dev')).expect(404);
  });

  it('maps a forge failure to 502 and a missing installation token to 409 repo_unreachable', async () => {
    forge.routes.set('GET /repos/acme/app/git/ref/heads/trunk', () => ({ status: 500, body: {} }));
    await request(server).get(`${base()}/nax-files`).set(auth('dev')).expect(502);
    forge.routes.delete('POST /app/installations/77/access_tokens');
    await request(server).get(`${base()}/nax-files`).set(auth('dev')).expect(409);
  });

  it('refuses edits from a VIEWER (403) and invalid edit sets (400)', async () => {
    await request(server).post(`${base()}/config-edits`).set(auth('viewer')).send(edit).expect(403);
    await request(server).post(`${base()}/config-edits`).set(auth('dev')).send({ ...edit, edits: [{ ...edit.edits[0], path: 'AGENTS.md' }] }).expect(400);
    await request(server).post(`${base()}/config-edits`).set(auth('dev')).send({ ...edit, edits: [] }).expect(400);
    await request(server).post(`${base()}/config-edits`).set(auth('dev')).send({ ...edit, prTitle: '' }).expect(400);
  });

  it('queues a CONFIG_EDIT for a DEVELOPER, stores the edit set, and serializes config jobs per repo (409)', async () => {
    const res = data<{ job: { id: string; command: string; state: string; ref: string; feature: string; maxCostUsd: string; configEdit: unknown } }>(
      await request(server).post(`${base()}/config-edits`).set(auth('dev')).send(edit).expect(201),
    );
    expect(res.job).toEqual(expect.objectContaining({
      command: 'CONFIG_EDIT', state: 'QUEUED', ref: 'trunk', feature: 'nax-config', maxCostUsd: '0',
      configEdit: { mode: 'edit', files: ['.nax/rules/testing.md'], prTitle: 'Tighten testing rule', result: null },
    }));
    const row = await prisma.fleetConfigEdit.findUniqueOrThrow({ where: { jobId: res.job.id } });
    expect(row).toEqual(expect.objectContaining({ mode: 'edit', baseSha: HEAD, prTitle: 'Tighten testing rule' }));

    const dup = await request(server).post(`${base()}/drift-checks`).set(auth('dev')).expect(409);
    expect(JSON.stringify(dup.body)).toContain(res.job.id);

    const detail = data<{ configEdit: unknown }>(await request(server).get(`/api/projects/web/fleet/jobs/${res.job.id}`).set(auth('viewer')).expect(200));
    expect(detail.configEdit).toEqual({ mode: 'edit', files: ['.nax/rules/testing.md'], prTitle: 'Tighten testing rule', result: null });
    const set = data<{ edits: unknown[]; baseSha: string }>(await request(server).get(`/api/projects/web/fleet/jobs/${res.job.id}/config-edit`).set(auth('viewer')).expect(200));
    expect(set.edits).toEqual(edit.edits);
    expect(set.baseSha).toBe(HEAD);

    await prisma.fleetJob.update({ where: { id: res.job.id }, data: { state: 'CANCELLED' } });
  });

  it('does not offer config kinds on the generic dispatch endpoint', async () => {
    await request(server).post('/api/projects/web/fleet/jobs').set(auth('dev'))
      .send({ repoId: world.repoId, command: 'CONFIG_EDIT', feature: 'nax-config', maxCostUsd: 1 }).expect(400);
  });

  it('places on an S3 runner and reports config_jobs for an older one', async () => {
    const old = await insertRunner(prisma, { name: 'old-box' });
    const drift = data<{ job: { id: string; state: string }; placement: { misfits: Array<{ runnerId: string; reason: string }> } }>(
      await request(server).post(`${base()}/drift-checks`).set(auth('dev')).expect(201),
    );
    expect(drift.job.state).toBe('QUEUED');
    expect(drift.placement.misfits).toEqual(expect.arrayContaining([expect.objectContaining({ runnerId: old.id, reason: 'config_jobs' })]));
    await prisma.fleetJob.update({ where: { id: drift.job.id }, data: { state: 'CANCELLED' } });
    await prisma.runner.update({ where: { id: old.id }, data: { enabled: false } });

    const s3 = await insertRunner(prisma, { name: 's3-box', capabilities: { ...FLEET_CAPS, configJobs: true } });
    const regen = data<{ job: { state: string; runnerId: string } }>(
      await request(server).post(`${base()}/config-edits/regenerate`).set(auth('dev')).send({ prTitle: 'Regenerate agent files' }).expect(201),
    );
    expect(regen.job).toEqual(expect.objectContaining({ state: 'ASSIGNED', runnerId: s3.id }));
  });
});
