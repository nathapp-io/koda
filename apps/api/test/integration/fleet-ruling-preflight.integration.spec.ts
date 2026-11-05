import request from 'supertest';
import { generateKeyPairSync } from 'crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { NathApplication } from '@nathapp/nestjs-app';
import { canRunDbTests } from '../helpers/test-environment';
import { bootHttpApp, data } from '../helpers/http-app';
import { fixtureDb } from '../helpers/action-context';
import { seedFleetHttpAgent, seedFleetHttpWorld } from '../helpers/fleet-fixtures';
import { resetDb } from '../helpers/reset-db';
import { FakeForge, startFakeForge } from '../helpers/fake-forge';
import { grantRole } from '../../src/permissions/test-helpers/permission-fixtures';
import { seedWaitPolicy } from '../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../src/permissions/permission-cache';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { FleetPrRulingsService } from '../../src/fleet/rulings/fleet-pr-rulings.service';

/** US-014 (#394): the ruling preflight over HTTP — CI items and a PR with no nax item index. */
const ENV_KEYS = ['GITHUB_API_URL', 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY_FILE', 'GITHUB_APP_SLUG'] as const;
const MARKER = '<!-- nax-bot:v1 key=w-index -->';

(canRunDbTests() ? describe : describe.skip)('fleet ruling preflight (PG)', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: Awaited<ReturnType<typeof seedFleetHttpWorld>>;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let forge: FakeForge;
  const saved: Record<string, string | undefined> = {};
  let seq = 0;
  /** The private key's directory: created once, removed with the suite (it holds a generated key, not a fixture). */
  let keyDir = '';

  beforeAll(async () => {
    forge = await startFakeForge();
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    keyDir = mkdtempSync(join(tmpdir(), 'gh-item-index-'));
    const keyFile = join(keyDir, 'app.pem');
    writeFileSync(keyFile, privateKey.export({ type: 'pkcs1', format: 'pem' }));
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    Object.assign(process.env, {
      GITHUB_API_URL: forge.url, GITHUB_APP_ID: '4242', GITHUB_APP_PRIVATE_KEY_FILE: keyFile, GITHUB_APP_SLUG: 'koda-fleet',
    });
    // 77 is the installation id every `seedFleetHttpWorld` repo is seeded with.
    forge.routes.set('POST /app/installations/77/access_tokens', () => ({ status: 201, body: { token: 'ghs_thread', expires_at: '2099-01-01T00:00:00Z' } }));

    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), db);
    agent = await seedFleetHttpAgent(app.getHttpServer(), world.tokens.root);
    await grantRole(db, { type: 'AGENT', id: agent.id }, 'developer', world.projectId);
    await app.get(PermissionCache).invalidate();
  }, 120000);
  beforeEach(async () => {
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
  });
  afterAll(async () => {
    await app?.close();
    await forge?.close();
    // M3: the generated key directory goes with the suite; nothing else removes it.
    if (keyDir !== '') rmSync(keyDir, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  const post = (jobId: string, body: { itemId: string; text: string }) =>
    request(app.getHttpServer()).post(`/api/projects/web/fleet/jobs/${jobId}/rulings`).set({ Authorization: `Bearer ${agent.apiKey}` }).send(body);
  const job = (openItems: { id: string; kind: string }[]) => {
    const prNumber = ++seq;
    return db.fleetJob.create({ data: {
      projectId: world.projectId, repoId: world.repoId, command: 'RUN', feature: `preflight-${prNumber}`, ref: 'main',
      profiles: [], selectorLabels: [], maxCostUsd: '1', requestedById: agent.id,
      resultPrUrl: `https://github.com/acme/app/pull/${prNumber}`, workflow: { outcome: 'draft', openItems },
    } });
  };
  const noWrites = async (jobId: string) => {
    expect(await db.fleetPrRuling.count({ where: { jobId } })).toBe(0);
    expect(await db.fleetJobTicket.count({ where: { jobId } })).toBe(0);
  };
  /**
   * Answer the refusal the route hit, with the exception `preflight` threw, so the assertion pins the
   * conflict code (`prefix`) rather than only its translated text.
   */
  const callPreflight = async (jobId: string, body: { itemId: string; text: string }): Promise<{ prefix: string; response: request.Response }> => {
    const service = app.get(FleetPrRulingsService);
    const original = service.preflight.bind(service);
    const calls: Promise<unknown>[] = [];
    const spy = vi.spyOn(service, 'preflight').mockImplementation((projectId, targetJobId, dto) => {
      const promise = original(projectId, targetJobId, dto);
      calls.push(promise.catch((error) => error));
      return promise;
    });
    try {
      const response = await post(jobId, body).expect(409);
      expect(calls).toHaveLength(1);
      return { prefix: (await calls[0] as { prefix: string }).prefix, response };
    } finally { spy.mockRestore(); }
  };

  it('AC-12: a ci item is refused with fleet.rulings.notRulable and writes nothing', async () => {
    const target = await job([{ id: 'C-1', kind: 'ci' }, { id: 'D-1', kind: 'finding' }]);
    const { prefix, response } = await callPreflight(target.id, { itemId: 'C-1', text: 'confirm: green' });
    expect(prefix).toBe('fleet.rulings.notRulable');
    expect(JSON.stringify(response.body)).toContain('CI items cannot be ruled; a FIX cannot settle them');
    await noWrites(target.id);
  });

  it('AC-13: a finding on a GitHub draft whose comments lack the marker is refused with fleet.rulings.noItemIndex', async () => {
    const target = await job([{ id: 'D-1', kind: 'finding' }]);
    forge.routes.set(`GET /repos/acme/app/issues/${seq}/comments`, () => ({ status: 200, body: [
      { id: 1, body: 'Looks good' }, { id: 2, body: 'nit: naming' }, { id: 3, body: 'LGTM' },
    ] }));
    const { prefix, response } = await callPreflight(target.id, { itemId: 'D-1', text: 'confirm: green' });
    expect(prefix).toBe('fleet.rulings.noItemIndex');
    expect(JSON.stringify(response.body)).toContain('This pull request has no nax item index');
    expect(forge.requests.filter((sent) => sent.path === `/repos/acme/app/issues/${seq}/comments`)).toEqual([
      expect.objectContaining({ method: 'GET', query: 'per_page=100', headers: expect.objectContaining({ authorization: 'Bearer ghs_thread' }) }),
    ]);
    await noWrites(target.id);
  });

  it('accepts the same ruling once the PR carries the nax item-index marker', async () => {
    const target = await job([{ id: 'D-1', kind: 'finding' }]);
    forge.routes.set(`GET /repos/acme/app/issues/${seq}/comments`, () => ({ status: 200, body: [
      { id: 1, body: `nax item index for this review\n${MARKER}` },
    ] }));
    expect(data(await post(target.id, { itemId: 'D-1', text: 'confirm: green' }).expect(201))).toMatchObject({ state: 'pending', disposition: 'confirmed' });
    expect(await db.fleetPrRuling.count({ where: { jobId: target.id } })).toBe(1);
  });

  it('F1: a deferred approval runs both preflights outside any transaction', async () => {
    const target = await job([{ id: 'D-1', kind: 'finding' }]);
    forge.routes.set(`GET /repos/acme/app/issues/${seq}/comments`, () => ({ status: 200, body: [
      { id: 1, body: `nax item index for this review\n${MARKER}` },
    ] }));
    const policy = await seedWaitPolicy(db, 'fleet.job.rule', world.projectId);
    await db.approvalPolicy.update({ where: { id: policy.id }, data: { mode: 'human' } });

    const service = app.get(FleetPrRulingsService);
    const transactions = app.get<{ isInTransaction(): boolean }>(TRANSACTION_MANAGER);
    const original = service.preflight.bind(service);
    const active: boolean[] = [];
    const spy = vi.spyOn(service, 'preflight').mockImplementation((projectId, jobId, dto) => {
      active.push(transactions.isInTransaction());
      return original(projectId, jobId, dto);
    });
    let requestId: string;
    try {
      requestId = data<{ id: string }>(await post(target.id, { itemId: 'D-1', text: 'confirm: green' }).expect(202)).id;
      expect(await db.fleetPrRuling.count({ where: { jobId: target.id } })).toBe(0);
      const decided = data<{ status: string }>(await request(app.getHttpServer()).post(`/api/approvals/${requestId}/decisions`)
        .set({ Authorization: `Bearer ${world.tokens.root}` }).send({ decision: 'approve' }).expect(200));
      expect(decided.status).toBe('executed');
    } finally { spy.mockRestore(); }

    // Request-time preflight and the deferred one: both read the forge with no transaction open.
    expect(active).toEqual([false, false]);
    expect(await db.fleetPrRuling.findMany({ where: { jobId: target.id } })).toEqual([
      expect.objectContaining({ state: 'pending', disposition: 'confirmed', approvalRequestId: requestId }),
    ]);
    expect(forge.requests.filter((sent) => sent.path === `/repos/acme/app/issues/${seq}/comments`)).toHaveLength(2);
  });
});
