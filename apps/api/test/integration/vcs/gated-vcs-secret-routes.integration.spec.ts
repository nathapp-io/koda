import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { APPROVAL_REDEEM_HEADER } from '../../../src/approvals/route/approval-gated.decorator';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { decryptToken } from '../../../src/common/utils/encryption.util';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
/** A 32-byte key, hex-encoded, as `encryptToken` expects; stubbed before the app boots. */
const ENCRYPTION_KEY = 'ab'.repeat(32);
interface Pending { id: string; permissionKey: string; projectId: string | null; redeem: boolean }
interface Created { webhookSecret: string; repoName: string }
interface Detail { input: Record<string, unknown>; result: unknown; status: string }
interface CreateBody { provider: string; repoOwner: string; repoName: string; token: string; syncMode: string }
interface Updated { syncMode: string; webhookSecret?: string }

describeIntegration('gated VCS secret routes', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let p: { id: string; slug: string };
  let repoSeq = 0;
  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const root = () => auth(world.tokens.root);
  const agentAuth = () => auth(agent.apiKey);
  /** A create body; every call gets its own repoName unless the case names one. */
  const body = (over: Partial<CreateBody> = {}): CreateBody => ({
    provider: 'github', repoOwner: 'acme', repoName: over.repoName ?? `widgets${++repoSeq}`,
    token: over.token ?? 'tok-1', syncMode: 'off',
  });
  const post = (payload: CreateBody, redeem?: string) => {
    const call = request(server()).post(`/api/projects/${p.slug}/vcs`).set(agentAuth()).send(payload);
    return redeem === undefined ? call : call.set(APPROVAL_REDEEM_HEADER, redeem);
  };
  const rootPost = (payload: CreateBody) =>
    request(server()).post(`/api/projects/${p.slug}/vcs`).set(root()).send(payload);
  const vcsPath = () => `/api/projects/${p.slug}/vcs`;
  const rotatePath = () => `${vcsPath()}/webhook-secret/rotate`;
  const patch = (payload: Record<string, unknown>, redeem?: string) => {
    const call = request(server()).patch(vcsPath()).set(agentAuth()).send(payload);
    return redeem === undefined ? call : call.set(APPROVAL_REDEEM_HEADER, redeem);
  };
  const rootPatch = (payload: Record<string, unknown>) =>
    request(server()).patch(vcsPath()).set(root()).send(payload);
  const rotate = (redeem?: string) => {
    const call = request(server()).post(rotatePath()).set(agentAuth());
    return redeem === undefined ? call : call.set(APPROVAL_REDEEM_HEADER, redeem);
  };
  const rootRotate = () => request(server()).post(rotatePath()).set(root());
  /** A connection created at once by root; the update/rotate cases each need their own row. */
  const rootConnection = (over: Partial<CreateBody> = {}) => rootPost(body(over)).expect(201);
  const pending = (response: request.Response) => {
    expect(response.status).toBe(202);
    return data<Pending>(response);
  };
  const approve = (id: string) =>
    request(server()).post(`/api/approvals/${id}/decisions`).set(root()).send({ decision: 'approve' }).expect(200);
  const detail = async (id: string) =>
    data<Detail>(await request(server()).get(`/api/approvals/${id}`).set(root()).expect(200));
  const connection = () => db.vcsConnection.findUnique({ where: { projectId: p.id } });
  const message = (key: string, status: string) => {
    const catalog = JSON.parse(readFileSync(join(__dirname, '../../../src/i18n/en/approvals.json'), 'utf8')) as Record<string, Record<string, string>>;
    return catalog[key][status];
  };

  beforeAll(async () => {
    vi.stubEnv('VCS_ENCRYPTION_KEY', ENCRYPTION_KEY);
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    p = data<{ id: string; slug: string }>(
      await request(server()).post('/api/projects').set(root()).send({ slug: 'gated-vcs', key: 'GVC', name: 'gated-vcs' }).expect(201),
    );
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
  }, 60_000);
  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.vcsConnection.deleteMany({ where: { projectId: p.id } });
    await grantKeys(db, { type: 'AGENT', id: agent.id }, [
      'project.read', 'vcs.connection.create', 'vcs.connection.update', 'vcs.webhook-secret.rotate',
    ], p.id);
    await app.get(PermissionCache).invalidate();
  });
  afterAll(async () => { await app?.close(); vi.unstubAllEnvs(); });

  it('AC-2: an agent under no policy opens a pending redeem request without creating a connection', async () => {
    const summary = pending(await post(body()));
    expect(summary).toMatchObject({ permissionKey: 'vcs.connection.create', redeem: true });
    expect(await connection()).toBeNull();
  });

  it('AC-3: the stored input carries the redacted token and never the sent one', async () => {
    const summary = pending(await post(body({ token: 'tok-1' })));
    const stored = (await detail(summary.id)).input as { connection: { token: string } };
    expect(stored.connection.token).toBe('<redacted>');
    expect(JSON.stringify(stored)).not.toContain('tok-1');
  });

  it('AC-4: redeeming the approved request creates the connection and answers its webhook secret once', async () => {
    const payload = body();
    const summary = pending(await post(payload));
    await approve(summary.id);
    const created = data<Created>(await post(payload, summary.id).expect(201));
    expect(created.webhookSecret).toEqual(expect.any(String));
    expect(created.webhookSecret.length).toBeGreaterThan(0);
    expect(created.repoName).toBe(payload.repoName);
    const row = await db.approvalRequest.findUniqueOrThrow({ where: { id: summary.id } });
    expect(row.status).toBe('executed');
    expect(row.result).not.toHaveProperty('webhookSecret');
  });

  it('AC-5: a redemption with another token value stores the re-sent token', async () => {
    const opened = body({ token: 'tok-1' });
    const summary = pending(await post(opened));
    await approve(summary.id);
    await post({ ...opened, token: 'tok-2' }, summary.id).expect(201);
    const stored = await connection();
    expect(stored).not.toBeNull();
    expect(decryptToken(stored?.encryptedToken ?? '', ENCRYPTION_KEY)).toBe('tok-2');
  });

  it('AC-6: a redemption with another repoName mismatches and creates nothing', async () => {
    const opened = body();
    const summary = pending(await post(opened));
    await approve(summary.id);
    const response = await post({ ...opened, repoName: 'other-widgets' }, summary.id).expect(409);
    expect(response.body.message).toBe(message('redeemMismatch', '409'));
    expect(await connection()).toBeNull();
  });

  it('AC-7: root creates at once and opens no approval request', async () => {
    const created = data<Created>(await rootPost(body()).expect(201));
    expect(created.webhookSecret.length).toBeGreaterThan(0);
    expect(await db.approvalRequest.count()).toBe(0);
  });

  // ── US-003: update and webhook-secret rotation, pinned to the connection ──────────────────────

  it('US-003 AC-1: an agent under no policy opens a pending update and changes nothing', async () => {
    await rootConnection();

    const summary = pending(await patch({ syncMode: 'polling' }));

    expect(summary).toMatchObject({ permissionKey: 'vcs.connection.update', redeem: true });
    expect((await connection())?.syncMode).toBe('off');
  });

  it('US-003 AC-2: redeeming the approved update applies it and settles the request', async () => {
    await rootConnection();
    const summary = pending(await patch({ syncMode: 'polling' }));
    await approve(summary.id);

    const updated = data<Updated>(await patch({ syncMode: 'polling' }, summary.id).expect(200));

    expect(updated.syncMode).toBe('polling');
    expect((await connection())?.syncMode).toBe('polling');
    const row = await db.approvalRequest.findUniqueOrThrow({ where: { id: summary.id } });
    expect(row.status).toBe('executed');
  });

  it('US-003 AC-3: the stored patch is redacted and the redemption stores the re-sent token', async () => {
    await rootConnection({ token: 'tok-old' });

    const summary = pending(await patch({ token: 'tok-new' }));

    const stored = (await detail(summary.id)).input as { patch: { token: string } };
    expect(stored.patch.token).toBe('<redacted>');
    expect(JSON.stringify(stored)).not.toContain('tok-new');

    await approve(summary.id);
    await patch({ token: 'tok-new' }, summary.id).expect(200);

    const row = await connection();
    expect(decryptToken(row?.encryptedToken ?? '', ENCRYPTION_KEY)).toBe('tok-new');
  });

  it('US-003 AC-4: a redemption that adds a token mismatches and leaves the stored token', async () => {
    await rootConnection({ token: 'tok-orig' });
    const summary = pending(await patch({ syncMode: 'polling' }));
    await approve(summary.id);

    const response = await patch({ syncMode: 'polling', token: 'tok-x' }, summary.id).expect(409);

    expect(response.body.message).toBe(message('redeemMismatch', '409'));
    const row = await connection();
    expect(decryptToken(row?.encryptedToken ?? '', ENCRYPTION_KEY)).toBe('tok-orig');
    expect(row?.syncMode).toBe('off');
  });

  it('US-003 AC-5: an update redeemed after the connection was replaced mismatches, stays approved', async () => {
    await rootConnection({ repoName: 'first-widgets' });
    const summary = pending(await patch({ syncMode: 'polling' }));
    await approve(summary.id);

    await db.vcsConnection.deleteMany({ where: { projectId: p.id } });
    await rootConnection({ repoName: 'second-widgets' });

    const response = await patch({ syncMode: 'polling' }, summary.id).expect(409);

    expect(response.body.message).toBe(message('redeemMismatch', '409'));
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: summary.id } })).status).toBe('approved');
    expect((await connection())?.syncMode).toBe('off');
  });

  it('US-003 AC-6: rotation opens pending, and redeeming it returns a new secret', async () => {
    const created = data<Created>(await rootConnection());
    const before = (await connection())?.webhookSecret;
    expect(before).toBe(created.webhookSecret);

    const summary = pending(await rotate());
    expect(summary).toMatchObject({ permissionKey: 'vcs.webhook-secret.rotate', redeem: true });

    await approve(summary.id);
    const rotated = data<Created>(await rotate(summary.id).expect(200));

    expect(rotated.webhookSecret).toEqual(expect.any(String));
    expect(rotated.webhookSecret.length).toBeGreaterThan(0);
    expect(rotated.webhookSecret).not.toBe(before);
    expect((await connection())?.webhookSecret).toBe(rotated.webhookSecret);
  });

  it('US-003 AC-7: a rotation request stores the connection and answers only rotated', async () => {
    await rootConnection();
    const created = await connection();
    const summary = pending(await rotate());
    await approve(summary.id);
    await rotate(summary.id).expect(200);

    const stored = await detail(summary.id);

    expect(stored.input).toEqual({ slug: p.slug, projectId: p.id, connectionId: created?.id });
    expect(stored.result).toEqual({ rotated: true });
  });

  it('US-003 AC-8: a rotation redeemed after the connection was replaced mismatches, stays approved', async () => {
    await rootConnection({ repoName: 'first-widgets' });
    const summary = pending(await rotate());
    await approve(summary.id);

    await db.vcsConnection.deleteMany({ where: { projectId: p.id } });
    await rootConnection({ repoName: 'second-widgets' });
    const replacement = (await connection())?.webhookSecret;

    const response = await rotate(summary.id).expect(409);

    expect(response.body.message).toBe(message('redeemMismatch', '409'));
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: summary.id } })).status).toBe('approved');
    expect((await connection())?.webhookSecret).toBe(replacement);
  });

  it('US-003 AC-9: root updates and rotates at once, opening no request', async () => {
    await rootConnection();

    const updated = data<Updated>(await rootPatch({ syncMode: 'polling' }).expect(200));
    expect(updated.syncMode).toBe('polling');

    const rotated = data<Created>(await rootRotate().expect(200));
    expect(rotated.webhookSecret.length).toBeGreaterThan(0);

    expect(await db.approvalRequest.count()).toBe(0);
  });

  it('US-003 AC-14: a redeemed webhook-mode update returns the generated secret, the row keeps none', async () => {
    await rootConnection();
    await db.vcsConnection.updateMany({ where: { projectId: p.id }, data: { webhookSecret: null, syncMode: 'off' } });

    const summary = pending(await patch({ syncMode: 'webhook' }));
    await approve(summary.id);

    const updated = data<Required<Updated>>(await patch({ syncMode: 'webhook' }, summary.id).expect(200));

    expect(updated.syncMode).toBe('webhook');
    expect(updated.webhookSecret).toEqual(expect.any(String));
    expect(updated.webhookSecret.length).toBeGreaterThan(0);
    expect((await connection())?.webhookSecret).toBe(updated.webhookSecret);

    const row = await db.approvalRequest.findUniqueOrThrow({ where: { id: summary.id } });
    expect(row.status).toBe('executed');
    expect(row.result).not.toHaveProperty('webhookSecret');
  });
});
