import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { APPROVAL_REDEEM_HEADER } from '../../../src/approvals/route/approval-gated.decorator';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

/**
 * US-004 — the two secret-bearing webhook writes behind the approval route gate, over HTTP + Postgres.
 *
 * `POST /api/projects/:slug/webhooks` and `PATCH /api/projects/:slug/webhooks/:id` run the gate as
 * redeem routes: an authorized agent under no policy gets 202 and a pending request whose stored input
 * carries no secret, and the requester redeems it by re-sending the body with `X-Koda-Approval-Request`.
 * The outbound URL guard runs in `prepare`, i.e. before the redemption's transaction.
 */
const describeIntegration = canRunDbTests() ? describe : describe.skip;
const ALLOWED_URL = 'https://93.184.215.14/hook';
const OTHER_ALLOWED_URL = 'https://93.184.215.15/hook';
const REDACTED_SECRET = '<redacted>';

interface Pending { id: string; permissionKey: string; projectId: string | null; redeem: boolean }
interface Detail { input: Record<string, unknown>; result: unknown; status: string }
interface WebhookDto { id: string; url: string; active: boolean; events: string; secret?: string }
interface CreateBody { url: string; events: string[]; secret?: string }

describeIntegration('gated webhook secret routes', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let p: { id: string; slug: string };
  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const root = () => auth(world.tokens.root);
  const agentAuth = () => auth(agent.apiKey);
  const collection = () => `/api/projects/${p.slug}/webhooks`;
  const item = (id: string) => `${collection()}/${id}`;
  /** A create body; a case that supplies a secret gets a 32-character one, the DTO's minimum. */
  const body = (over: Partial<CreateBody> = {}): CreateBody => ({
    url: over.url ?? ALLOWED_URL, events: over.events ?? ['ticket.created'], ...(over.secret === undefined ? {} : { secret: over.secret }),
  });
  const post = (payload: CreateBody, redeem?: string) => {
    const call = request(server()).post(collection()).set(agentAuth()).send(payload);
    return redeem === undefined ? call : call.set(APPROVAL_REDEEM_HEADER, redeem);
  };
  const patch = (id: string, payload: Record<string, unknown>, redeem?: string) => {
    const call = request(server()).patch(item(id)).set(agentAuth()).send(payload);
    return redeem === undefined ? call : call.set(APPROVAL_REDEEM_HEADER, redeem);
  };
  /** A webhook created at once by root; the update cases each need their own row. */
  const rootWebhook = async (url = ALLOWED_URL): Promise<WebhookDto> =>
    data<WebhookDto>(await request(server()).post(collection()).set(root()).send(body({ url })).expect(201));
  const stored = (id: string) => db.webhook.findUnique({ where: { id } });
  const pending = (response: request.Response): Pending => {
    expect(response.status).toBe(202);
    return data<Pending>(response);
  };
  const approve = (id: string) =>
    request(server()).post(`/api/approvals/${id}/decisions`).set(root()).send({ decision: 'approve' }).expect(200);
  const detail = async (id: string) =>
    data<Detail>(await request(server()).get(`/api/approvals/${id}`).set(root()).expect(200));
  const row = (id: string) => db.approvalRequest.findUniqueOrThrow({ where: { id } });

  const translations = (file: string): Record<string, unknown> =>
    JSON.parse(readFileSync(join(__dirname, '../../../src/i18n/en', file), 'utf8')) as Record<string, unknown>;
  const mismatchMessage = (): string =>
    (translations('approvals.json')['redeemMismatch'] as Record<string, string>)['409'] as string;
  const notFoundMessage = (): string => translations('webhooks.json')['404'] as string;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    p = data<{ id: string; slug: string }>(
      await request(server()).post('/api/projects').set(root()).send({ slug: 'gated-webhooks', key: 'GWH', name: 'gated-webhooks' }).expect(201),
    );
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
  }, 60_000);

  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.webhook.deleteMany({ where: { projectId: p.id } });
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read', 'webhook.create', 'webhook.update'], p.id);
    await app.get(PermissionCache).invalidate();
  });

  afterAll(async () => { await app?.close(); });

  it('AC-1: an agent under no policy opens a pending redeem request and creates no webhook', async () => {
    const summary = pending(await post({ url: ALLOWED_URL, events: ['ticket.created'] }));

    expect(summary).toMatchObject({ permissionKey: 'webhook.create', redeem: true });
    expect(await db.webhook.count({ where: { projectId: p.id } })).toBe(0);
  });

  it('AC-2: a create request opened without a secret redeems to a generated 40-character hex secret', async () => {
    const summary = pending(await post(body()));
    await approve(summary.id);

    const created = data<WebhookDto>(await post(body(), summary.id).expect(201));

    expect(created.secret).toMatch(/^[0-9a-f]{40}$/);
    expect((await stored(created.id))?.secret).toBe(created.secret);
    const settled = await row(summary.id);
    expect(settled.status).toBe('executed');
    expect(settled.result).not.toHaveProperty('secret');
  });

  it('AC-3: a supplied secret is stored redacted and the redemption writes the re-sent one', async () => {
    const secret = 's'.repeat(32);
    const summary = pending(await post(body({ secret })));

    const opened = (await detail(summary.id)).input as { webhook: { secret: string } };
    expect(opened.webhook.secret).toBe(REDACTED_SECRET);
    expect(JSON.stringify(opened)).not.toContain(secret);

    await approve(summary.id);
    await post(body({ secret }), summary.id).expect(201);

    const created = await db.webhook.findFirstOrThrow({ where: { projectId: p.id } });
    expect(created.secret).toBe(secret);
  });

  it('AC-4: redeeming with a secret the request was not opened for mismatches and creates nothing', async () => {
    const summary = pending(await post(body()));
    await approve(summary.id);

    const response = await post(body({ secret: 'x'.repeat(32) }), summary.id).expect(409);

    expect(response.body.message).toBe(mismatchMessage());
    expect(await db.webhook.count({ where: { projectId: p.id } })).toBe(0);
  });

  it('AC-5: redeeming an update with an added url mismatches and leaves the webhook alone', async () => {
    const webhook = await rootWebhook();
    const summary = pending(await patch(webhook.id, { active: false }));
    await approve(summary.id);

    const response = await patch(webhook.id, { active: false, url: OTHER_ALLOWED_URL }, summary.id).expect(409);

    expect(response.body.message).toBe(mismatchMessage());
    const current = await stored(webhook.id);
    expect(current?.url).toBe(ALLOWED_URL);
    expect(current?.active).toBe(true);
  });

  it('AC-6: an agent update waits, and its redemption answers the secret-free view', async () => {
    const webhook = await rootWebhook();

    const summary = pending(await patch(webhook.id, { active: false }));
    expect(summary).toMatchObject({ permissionKey: 'webhook.update', redeem: true });
    expect((await stored(webhook.id))?.active).toBe(true);

    await approve(summary.id);
    const updated = data<WebhookDto>(await patch(webhook.id, { active: false }, summary.id).expect(200));

    expect(updated.active).toBe(false);
    expect(updated).not.toHaveProperty('secret');
    expect((await stored(webhook.id))?.active).toBe(false);
  });

  it('AC-7: an approved update whose webhook was deleted answers 404 webhooks and settles failed', async () => {
    const webhook = await rootWebhook();
    const summary = pending(await patch(webhook.id, { active: false }));
    await approve(summary.id);
    await db.webhook.delete({ where: { id: webhook.id } });

    const response = await patch(webhook.id, { active: false }, summary.id).expect(404);

    expect(response.body.message).toBe(notFoundMessage());
    expect((await row(summary.id)).status).toBe('failed');
  });

  it('AC-8: root creates and updates at once, opening no approval request', async () => {
    const created = await rootWebhook();
    const updated = data<WebhookDto>(
      await request(server()).patch(item(created.id)).set(root()).send({ active: false }).expect(200),
    );

    expect(created.url).toBe(ALLOWED_URL);
    expect(updated.active).toBe(false);
    expect((await stored(created.id))?.active).toBe(false);
    expect(await db.approvalRequest.count()).toBe(0);
  });

  it('AC-13: an update patch stores its secret redacted and the redemption writes the re-sent one', async () => {
    const webhook = await rootWebhook();
    const opened = 's'.repeat(32);
    const summary = pending(await patch(webhook.id, { secret: opened }));

    const detailInput = (await detail(summary.id)).input as { patch: { secret: string } };
    expect(detailInput.patch.secret).toBe(REDACTED_SECRET);
    expect(JSON.stringify(detailInput)).not.toContain(opened);

    await approve(summary.id);
    const updated = data<WebhookDto>(await patch(webhook.id, { secret: 't'.repeat(32) }, summary.id).expect(200));

    expect(updated).not.toHaveProperty('secret');
    expect((await stored(webhook.id))?.secret).toBe('t'.repeat(32));
  });

  it('US-004 boundary: a blocked destination at redemption answers 400 webhooks and settles failed', async () => {
    const webhook = await rootWebhook();
    const summary = pending(await patch(webhook.id, { url: 'https://10.0.0.5/hook' }));
    await approve(summary.id);

    const response = await patch(webhook.id, { url: 'https://10.0.0.5/hook' }, summary.id).expect(400);

    expect(String(response.body.message)).toContain('blocked_destination');
    expect((await stored(webhook.id))?.url).toBe(ALLOWED_URL);
    expect((await row(summary.id)).status).toBe('failed');
  });
});
