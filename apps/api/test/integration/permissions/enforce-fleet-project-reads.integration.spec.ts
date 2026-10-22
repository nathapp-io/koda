/**
 * Permissions P1d US-004 — the fleet project reads decide with catalog keys, over real HTTP +
 * Postgres (AC-1 .. AC-20). R10 ("logs, spend and dashboards are for people") is retired: a rostered
 * agent holds the read keys like a user, and a caller whose only source in `p1` is a custom role
 * holding nothing but `ticket.read` is refused with the `permissions` code.
 *
 * One booted application for the whole file. The first registration is the installation's Owner, so
 * the fixtures (users, project, repo, log bytes, bundle bytes, agent bindings) are built as that
 * Owner; every assertion below acts as a principal whose only source in `p1` is one role binding
 * (users and agents). No test asserts through a bypass.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/permissions/enforce-fleet-project-reads.integration.spec.ts
 */
import { createHash, randomUUID } from 'crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { MembershipService } from '../../../src/permissions/membership.service';
import { expectBindingOnlyFixtures, grantBaseline, grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const P1_SLUG = 'p1';
const P1_KEY = 'PONE';
const TIMEOUT = 30_000;
const BOOT_TIMEOUT = 60_000;
/** A window the analytics routes accept: a UTC date start, an exclusive UTC instant end. */
const WINDOW = 'from=2026-01-01&to=2026-02-01';

const readI18n = (file: string): Record<string, string> =>
  JSON.parse(readFileSync(join(__dirname, `../../../src/i18n/en/${file}.json`), 'utf8')) as Record<string, string>;

/** `permissions.40003`, the sentence every refused key carries. */
const PERMISSIONS_REFUSED = readI18n('permissions')['40003'];

const sha = (body: Buffer): string => createHash('sha256').update(body).digest('hex');
const logLine = (message: string): string =>
  `${JSON.stringify({ timestamp: '2026-10-04T08:00:00.000Z', level: 'info', stage: 'run', storyId: 'US-004', message })}\n`;

describeIntegration('fleet project read keys (US-004)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let membership: MembershipService;
  let artifactDir = '';
  let savedArtifactDir: string | undefined;

  const tokens: Record<string, string> = {};
  const userIds: Record<string, string> = {};
  let p1Id = '';
  let repoId = '';
  let counter = 0;
  let rootId = '';
  let rosterAgentId = '';

  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const asRoot = (method: 'get' | 'post' | 'patch' | 'delete', url: string, body?: Record<string, unknown>) => {
    const req = request(server)[method](url).set(auth('root'));
    return body === undefined ? req : req.send(body);
  };
  const getAs = (who: string, url: string) => request(server).get(url).set(auth(who));

  /** The refusal contract of one refused permission key: 403, code 40003, the exact sentence. */
  const expectPermissionsRefusal = (res: request.Response): void => {
    expect(res.status).toBe(403);
    expect(res.body.ret).toBe(40003);
    expect(res.body.message).toBe(PERMISSIONS_REFUSED);
  };

  const createUser = async (who: string): Promise<void> => {
    const created = await asRoot('post', '/api/admin/users', {
      email: `${who}@koda.test`,
      name: who,
      password: TEST_PASSWORD,
      role: 'MEMBER',
    }).expect(201);
    userIds[who] = data<{ id: string }>(created).id;
    resetThrottle(app);
    tokens[who] = await loginToken(server, `${who}@koda.test`);
  };

  /** The binding that is the caller's only source in p1. */
  const bind = (who: string, roleKey: string): Promise<unknown> =>
    membership.createBinding(
      { principal: { type: 'USER', id: userIds[who] }, roleKey, projectId: p1Id },
      { type: 'SYSTEM', id: 'test' },
    );

  /** A rostered agent with no agent role: its only key source in p1 is the `viewer` binding. */
  const createRosterAgent = async (slug: string): Promise<string> => {
    const created = await asRoot('post', '/api/agents', { name: slug, slug }).expect(201);
    const body = data<{ apiKey: string; agent: { id: string } }>(created);
    const agent = { type: 'AGENT' as const, id: body.agent.id };
    await grantBaseline(db, agent);
    await grantRole(db, agent, 'viewer', p1Id);
    tokens[slug] = body.apiKey;
    // The binding is written after the principal could have been cached by an earlier check.
    await membership.invalidatePermissions();
    return body.agent.id;
  };

  /** A job of p1; the default requester is `other`. */
  const newJob = async (over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}): Promise<{ id: string }> =>
    db.fleetJob.create({
      data: {
        projectId: p1Id, repoId, ref: 'trunk', command: 'RUN', feature: `job-${(counter += 1)}`, profiles: [],
        maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: userIds.other, state: 'RUNNING',
        leaseEpoch: 1, ...over,
      },
      select: { id: true },
    });

  /** A job whose attempt 1 uploaded a `run` log, on disk and in the index row. */
  const jobWithRunLog = async (): Promise<{ id: string }> => {
    const job = await newJob();
    const bytes = Buffer.from(logLine('built') + logLine('tested'));
    const path = join(artifactDir, 'logs', job.id, '1', 'run.log');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    await db.fleetJobLog.create({
      data: { jobId: job.id, leaseEpoch: 1, stream: 'run', sizeBytes: BigInt(bytes.length), complete: true },
    });
    return job;
  };

  /** A finished job whose attempt 1 stored a bundle, on disk and in the artifact row. */
  const jobWithBundle = async (): Promise<{ id: string }> => {
    const job = await newJob({ state: 'COMPLETED', finishedAt: new Date() });
    const bytes = Buffer.from('bundle-bytes');
    const storageKey = `jobs/${job.id}/1/${randomUUID()}.tar.gz`;
    const path = join(artifactDir, storageKey);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    await db.fleetJobArtifact.create({
      data: { jobId: job.id, leaseEpoch: 1, kind: 'bundle', storageKey, sizeBytes: BigInt(bytes.length), sha256: sha(bytes) },
    });
    return job;
  };

  const logsUrl = (jobId: string, suffix = '') => `/api/projects/${P1_SLUG}/fleet/jobs/${jobId}/logs${suffix}`;

  beforeAll(async () => {
    savedArtifactDir = process.env.FLEET_ARTIFACT_DIR;
    artifactDir = mkdtempSync(join(tmpdir(), 'koda-enforce-fleet-reads-'));
    process.env.FLEET_ARTIFACT_DIR = artifactDir;
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    server = app.getHttpServer();
    db = app.get<PrismaService<PrismaClient>>(PrismaService).client as PrismaClient;
    membership = app.get(MembershipService);

    const root = await request(server)
      .post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD })
      .expect(201);
    tokens.root = data<{ accessToken: string }>(root).accessToken;
    rootId = (await db.user.findUniqueOrThrow({ where: { email: 'root@koda.test' } })).id;

    for (const who of ['viewer', 'other', 'custom']) await createUser(who);

    const project = await asRoot('post', '/api/projects', { name: 'P1', slug: P1_SLUG, key: P1_KEY }).expect(201);
    p1Id = data<{ id: string }>(project).id;
    repoId = (
      await db.fleetRepo.create({
        data: { projectId: p1Id, provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'trunk', createdById: rootId },
      })
    ).id;

    await bind('viewer', 'viewer');
    // AC-3 / AC-4: a custom role that holds only project access and `ticket.read`, so every fleet read
    // is refused. US-001: `project.read` is what lets the caller reach the project at all.
    await db.role.create({
      data: {
        key: 'ticket-reader',
        name: 'Ticket Reader',
        scope: 'PROJECT',
        permissions: ['project.read', 'ticket.read'],
      },
    });
    await bind('custom', 'ticket-reader');

    rosterAgentId = await createRosterAgent('p1-roster-agent');
  }, BOOT_TIMEOUT);

  afterAll(async () => {
    await app?.close();
    if (savedArtifactDir === undefined) delete process.env.FLEET_ARTIFACT_DIR;
    else process.env.FLEET_ARTIFACT_DIR = savedArtifactDir;
    if (artifactDir !== '') rmSync(artifactDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // The sentinel: every fixture principal of this file is granted through bindings only
  // -------------------------------------------------------------------------

  it('fixtures grant through bindings only', async () => {
    await expectBindingOnlyFixtures(db, [
      { type: 'USER', id: rootId },
      { type: 'USER', id: userIds.viewer },
      { type: 'USER', id: userIds.other },
      { type: 'USER', id: userIds.custom },
      { type: 'AGENT', id: rosterAgentId },
    ]);
  });

  // -------------------------------------------------------------------------
  // AC-1 / AC-2 / AC-3 — a rostered agent reads the logs (R10 retired)
  // -------------------------------------------------------------------------

  it('AC-1: a roster-only agent lists a job log streams (200)', async () => {
    const job = await newJob();

    await getAs('p1-roster-agent', logsUrl(job.id)).expect(200);
  }, TIMEOUT);

  it('AC-2: the roster-only agent pages a job run log entries (200)', async () => {
    const job = await jobWithRunLog();

    const res = await getAs('p1-roster-agent', logsUrl(job.id, '/run/entries')).expect(200);

    expect(data<{ entries: Array<{ message: string }> }>(res).entries.map((entry) => entry.message)).toEqual([
      'built',
      'tested',
    ]);
  }, TIMEOUT);

  it('AC-3: the roster-only agent downloads the raw run log (200)', async () => {
    const job = await jobWithRunLog();

    const res = await getAs('p1-roster-agent', logsUrl(job.id, '/run/raw?download=1')).expect(200);

    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.text).toBe(logLine('built') + logLine('tested'));
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-4 / AC-5 / AC-6 — the log and bundle reads need their own keys
  // -------------------------------------------------------------------------

  it('AC-4: a ticket.read-only custom role is refused by the log list with the permissions code', async () => {
    const job = await newJob();

    expectPermissionsRefusal(await getAs('custom', logsUrl(job.id)));
  }, TIMEOUT);

  it('AC-5: the ticket.read-only custom role is refused by the bundle download', async () => {
    const job = await jobWithBundle();

    expectPermissionsRefusal(await getAs('custom', `/api/projects/${P1_SLUG}/fleet/jobs/${job.id}/bundle`));
  }, TIMEOUT);

  it('AC-6: a viewer binding downloads a stored bundle (200)', async () => {
    const job = await jobWithBundle();

    const res = await getAs('viewer', `/api/projects/${P1_SLUG}/fleet/jobs/${job.id}/bundle`).expect(200);

    expect(res.headers['content-type']).toMatch(/^application\/gzip/);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-7 / AC-8 / AC-9 — the project analytics reads
  // -------------------------------------------------------------------------

  it('AC-7: a roster-only agent reads the project spend analytics (200)', async () => {
    await getAs('p1-roster-agent', `/api/projects/${P1_SLUG}/fleet/analytics/spend?${WINDOW}`).expect(200);
  }, TIMEOUT);

  it('AC-8: the roster-only agent reads one job analytics (200)', async () => {
    const job = await jobWithBundle();

    await getAs('p1-roster-agent', `/api/projects/${P1_SLUG}/fleet/jobs/${job.id}/analytics`).expect(200);
  }, TIMEOUT);

  it('AC-9: the ticket.read-only custom role is refused by the quality analytics', async () => {
    const res = await getAs('custom', `/api/projects/${P1_SLUG}/fleet/analytics/quality?${WINDOW}`);

    expectPermissionsRefusal(res);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-10 / AC-11 — the project dashboard
  // -------------------------------------------------------------------------

  it('AC-10: a roster-only agent reads the project dashboard (200)', async () => {
    await getAs('p1-roster-agent', `/api/projects/${P1_SLUG}/fleet/dashboard`).expect(200);
  }, TIMEOUT);

  it('AC-11: the ticket.read-only custom role is refused by the project dashboard', async () => {
    const res = await getAs('custom', `/api/projects/${P1_SLUG}/fleet/dashboard`);

    expectPermissionsRefusal(res);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-12 / AC-13 / AC-14 / AC-15 — the runner and repo lists
  // -------------------------------------------------------------------------

  it('AC-12: a viewer binding lists the project runners (200)', async () => {
    await getAs('viewer', `/api/projects/${P1_SLUG}/fleet/runners`).expect(200);
  }, TIMEOUT);

  it('AC-13: a viewer binding lists the project repos (200)', async () => {
    const res = await getAs('viewer', `/api/projects/${P1_SLUG}/fleet/repos`).expect(200);

    expect(data<{ records: Array<{ id: string }> }>(res).records.map((repo) => repo.id)).toEqual([repoId]);
  }, TIMEOUT);

  it('AC-14: the ticket.read-only custom role is refused by the runner list', async () => {
    const res = await getAs('custom', `/api/projects/${P1_SLUG}/fleet/runners`);

    expectPermissionsRefusal(res);
  }, TIMEOUT);

  it('AC-15: the ticket.read-only custom role is refused by the repo list', async () => {
    const res = await getAs('custom', `/api/projects/${P1_SLUG}/fleet/repos`);

    expectPermissionsRefusal(res);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-20 — a refused key stops the request before the handler
  // -------------------------------------------------------------------------

  it('AC-20: a refused log read answers 403 permissions for an unknown job, while the key holder gets the handler 404', async () => {
    const unknown = `nope-${(counter += 1)}`;

    expectPermissionsRefusal(await getAs('custom', logsUrl(unknown)));
    expectPermissionsRefusal(await getAs('custom', `/api/projects/${P1_SLUG}/fleet/jobs/${unknown}/bundle`));

    // The same URLs reach the handler for a key holder: proof the refusals above were the guard's.
    await getAs('viewer', logsUrl(unknown)).expect(404);
    await getAs('viewer', `/api/projects/${P1_SLUG}/fleet/jobs/${unknown}/bundle`).expect(404);
  }, TIMEOUT);
});
