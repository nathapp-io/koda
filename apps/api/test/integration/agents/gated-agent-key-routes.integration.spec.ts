import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { ApprovalRequestExpirySweeper } from '../../../src/approvals/approval-request-expiry.sweeper';
import { APPROVAL_REDEEM_HEADER } from '../../../src/approvals/route/approval-gated.decorator';
import { grantKeys, seedWaitPolicy } from '../../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

/**
 * Permissions P3 `gate-secret` (US-006) — the two credential routes redeem instead of executing.
 *
 * An agent that holds `agent.create` / `agent.key.rotate` and meets a wait policy opens a request.
 * Approving it releases the request and runs nothing; the requester redeems it by repeating the same
 * call with `X-Koda-Approval-Request`, and the one-time raw key comes back in that answer only. The
 * settled row stores the agent, never the key.
 *
 * The nax sandbox withholds host Postgres; the suite skips there and runs on the host with
 * `KODA_DB_TESTS=1` (`bun run test:scoped test/integration/agents/gated-agent-key-routes.integration.spec.ts`).
 */
const describeIntegration = canRunDbTests() ? describe : describe.skip;

/** What a pending gated write answers (the 202 summary). */
interface PendingSummary {
  id: string;
  permissionKey: string;
  projectId: string | null;
  redeem: boolean;
  status: string;
}
/** What a settled request answers to the decide route. */
interface DecidedRequest { status: string }
/** The credential answer both routes share. */
interface AgentCredentials { apiKey: string; agent: { id: string; slug: string } }

describeIntegration('gated agent credential routes (US-006)', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let actor: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let serial = 0;

  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const rootAuth = () => auth(world.tokens.root);
  const newSlug = (base: string) => `${base}-${++serial}`;
  const createBody = () => ({ name: 'Gated Agent', slug: newSlug('gated-agent'), capabilities: ['nax'] });
  const create = (body: object, options: { token?: string; redeem?: string } = {}) => {
    const call = request(server()).post('/api/agents').set(auth(options.token ?? actor.apiKey)).send(body);
    return options.redeem === undefined ? call : call.set(APPROVAL_REDEEM_HEADER, options.redeem);
  };
  const rotate = (slug: string, options: { redeem?: string; token?: string } = {}) => {
    const call = request(server()).post(`/api/agents/${slug}/rotate-key`).set(auth(options.token ?? actor.apiKey));
    return options.redeem === undefined ? call : call.set(APPROVAL_REDEEM_HEADER, options.redeem);
  };
  const me = (token: string) => request(server()).get('/api/agents/me').set(auth(token));
  const pending = (res: request.Response) => {
    expect(res.status).toBe(202);
    return data<PendingSummary>(res);
  };
  const approve = async (id: string) => data<DecidedRequest>(
    await request(server()).post(`/api/approvals/${id}/decisions`).set(rootAuth()).send({ decision: 'approve' }).expect(200),
  );
  const requestRow = (id: string) => db.approvalRequest.findUniqueOrThrow({ where: { id } });
  const agentBySlug = (slug: string) => db.agent.findUnique({ where: { slug } });
  /** A policy for *every* principal type, so a human caller meets one too. */
  const seedPolicyForAnyPrincipal = (key: string) => db.approvalPolicy.create({
    data: {
      selector: `*|${key}|any`, projectId: null, permissionPattern: key, principalType: null,
      mode: 'agent', updatedByType: 'SYSTEM', updatedById: 'test',
    },
  });
  /** The API's own English approvals catalog, so a wording change does not silently pass. */
  const message = (key: string, status: string, args: Record<string, string> = {}) => {
    const catalog = JSON.parse(
      readFileSync(join(__dirname, '../../../src/i18n/en/approvals.json'), 'utf8'),
    ) as Record<string, Record<string, string>>;
    return Object.entries(args).reduce((text, [name, value]) => text.replace(`{${name}}`, value), catalog[key][status]);
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    actor = await seedFleetHttpAgent(server(), world.tokens.root);
    // The requester holds precisely the two keys it exercises, in the global scope.
    await grantKeys(db, { type: 'AGENT', id: actor.id }, ['agent.create', 'agent.key.rotate'], null);
    await app.get(PermissionCache).invalidate();
  }, 60_000);

  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
  });

  afterAll(async () => { await app?.close(); });

  it('AC-1: create waits on a redeem request and writes no agent', async () => {
    await seedWaitPolicy(db, 'agent.create', null);
    const body = createBody();

    const summary = pending(await create(body));

    expect(summary).toMatchObject({ permissionKey: 'agent.create', projectId: null, redeem: true });
    expect(await agentBySlug(body.slug)).toBeNull();
  });

  it('AC-2: approving a create request runs nothing and restarts the window', async () => {
    await seedWaitPolicy(db, 'agent.create', null);
    const body = createBody();
    const summary = pending(await create(body));
    const before = await requestRow(summary.id);

    expect(await approve(summary.id)).toMatchObject({ status: 'approved' });

    expect(await agentBySlug(body.slug)).toBeNull();
    const after = await requestRow(summary.id);
    expect(after.status).toBe('approved');
    expect(after.expiresAt.getTime()).toBeGreaterThan(before.expiresAt.getTime());
  });

  it('AC-3: redeeming an approved create request answers the new key and settles the request', async () => {
    await seedWaitPolicy(db, 'agent.create', null);
    const body = createBody();
    const summary = pending(await create(body));
    await approve(summary.id);

    const res = await create(body, { redeem: summary.id }).expect(201);

    const credentials = data<AgentCredentials>(res);
    expect(credentials.agent.slug).toBe(body.slug);
    expect(credentials.apiKey).toMatch(/^[a-f0-9]{64}$/);
    expect((await requestRow(summary.id)).status).toBe('executed');
  });

  it('AC-4: the settled row stores the agent without the key, and the whole create body as input', async () => {
    await seedWaitPolicy(db, 'agent.create', null);
    const body = createBody();
    const summary = pending(await create(body));
    await approve(summary.id);
    await create(body, { redeem: summary.id }).expect(201);

    const row = await requestRow(summary.id);
    const result = row.result as { agent: Record<string, unknown> } & Record<string, unknown>;
    expect(result.agent.slug).toBe(body.slug);
    expect(result).not.toHaveProperty('apiKey');
    expect(result.agent).not.toHaveProperty('apiKey');
    expect(row.input).toEqual({ agent: body });
  });

  it('AC-5: the redeemed key authenticates GET /agents/me', async () => {
    await seedWaitPolicy(db, 'agent.create', null);
    const body = createBody();
    const summary = pending(await create(body));
    await approve(summary.id);
    const { apiKey } = data<AgentCredentials>(await create(body, { redeem: summary.id }).expect(201));

    const profile = await me(apiKey).expect(200);

    expect(data<{ slug: string }>(profile).slug).toBe(body.slug);
  });

  it('AC-6: a differing name answers redeemMismatch and writes no agent', async () => {
    await seedWaitPolicy(db, 'agent.create', null);
    const body = createBody();
    const summary = pending(await create(body));
    await approve(summary.id);

    const res = await create({ ...body, name: 'Someone Else' }, { redeem: summary.id }).expect(409);

    expect(res.body.ret).toBe(409);
    expect(res.body.message).toBe(message('redeemMismatch', '409'));
    expect(await agentBySlug(body.slug)).toBeNull();
  });

  it('AC-7: redeeming the same create request twice answers notPending', async () => {
    await seedWaitPolicy(db, 'agent.create', null);
    const body = createBody();
    const summary = pending(await create(body));
    await approve(summary.id);
    await create(body, { redeem: summary.id }).expect(201);

    const res = await create(body, { redeem: summary.id }).expect(409);

    expect(res.body.message).toBe(message('notPending', '409', { status: 'executed' }));
    expect(await db.agent.count({ where: { slug: body.slug } })).toBe(1);
  });

  it('AC-8: another agent holding the key cannot redeem the request', async () => {
    await seedWaitPolicy(db, 'agent.create', null);
    const body = createBody();
    const summary = pending(await create(body));
    await approve(summary.id);
    const other = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: other.id }, ['agent.create'], null);
    await app.get(PermissionCache).invalidate();

    const res = await create(body, { token: other.apiKey, redeem: summary.id }).expect(404);

    expect(res.body.ret).toBe(404);
    expect(res.body.message).toBe(message('requestNotFound', '404'));
    expect(await agentBySlug(body.slug)).toBeNull();
  });

  it('AC-9: redeeming before the approval answers notPending with the pending status', async () => {
    await seedWaitPolicy(db, 'agent.create', null);
    const body = createBody();
    const summary = pending(await create(body));

    const res = await create(body, { redeem: summary.id }).expect(409);

    expect(res.body.message).toBe(message('notPending', '409', { status: 'pending' }));
    expect(res.body.message).toContain('pending');
    expect(await agentBySlug(body.slug)).toBeNull();
  });

  it('AC-10: redeeming an approved rotate request replaces the key it rotates', async () => {
    await seedWaitPolicy(db, 'agent.key.rotate', null);
    const target = await seedFleetHttpAgent(server(), world.tokens.root);
    const summary = pending(await rotate(target.slug));

    expect(await approve(summary.id)).toMatchObject({ status: 'approved' });
    const res = await rotate(target.slug, { redeem: summary.id }).expect(200);

    const rotated = data<AgentCredentials>(res);
    expect(rotated.apiKey).toMatch(/^[a-f0-9]{64}$/);
    expect(rotated.apiKey).not.toBe(target.apiKey);
    expect(rotated.agent.slug).toBe(target.slug);
    await me(rotated.apiKey).expect(200);
    await me(target.apiKey).expect(401);
    expect((await requestRow(summary.id)).status).toBe('executed');
  });

  it('AC-11: a rotate request whose slug was reused answers redeemMismatch and leaves the replacement alone', async () => {
    await seedWaitPolicy(db, 'agent.key.rotate', null);
    const original = await seedFleetHttpAgent(server(), world.tokens.root);
    const summary = pending(await rotate(original.slug));
    await approve(summary.id);
    await request(server()).delete(`/api/agents/${original.slug}`).set(rootAuth()).expect(200);
    const replacement = data<AgentCredentials>(await request(server()).post('/api/agents').set(rootAuth())
      .send({ name: 'Replacement', slug: original.slug }).expect(201));
    const before = await db.agent.findUniqueOrThrow({ where: { id: replacement.agent.id } });

    const res = await rotate(original.slug, { redeem: summary.id }).expect(409);

    expect(res.body.message).toBe(message('redeemMismatch', '409'));
    const after = await db.agent.findUniqueOrThrow({ where: { id: replacement.agent.id } });
    expect(after.apiKeyHash).toBe(before.apiKeyHash);
    // The slug is A's, the id it froze is not the replacement's: nothing ran.
    expect((await requestRow(summary.id)).status).toBe('approved');
  });

  it('AC-12: the sweeper expires an approved create request past its window, and redeeming it says so', async () => {
    await seedWaitPolicy(db, 'agent.create', null);
    const body = createBody();
    const summary = pending(await create(body));
    await approve(summary.id);
    await db.approvalRequest.update({ where: { id: summary.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });

    await app.get(ApprovalRequestExpirySweeper, { strict: false }).tick();

    expect((await requestRow(summary.id)).status).toBe('expired');
    const res = await create(body, { redeem: summary.id }).expect(409);
    expect(res.body.message).toBe(message('notPending', '409', { status: 'expired' }));
    expect(await agentBySlug(body.slug)).toBeNull();
  });

  it('AC-13: a human create under a wait policy executes at once and opens no request', async () => {
    await seedPolicyForAnyPrincipal('agent.create');
    const body = createBody();

    const res = await create(body, { token: world.tokens.root }).expect(201);

    expect(data<AgentCredentials>(res).apiKey).toMatch(/^[a-f0-9]{64}$/);
    expect(await db.approvalRequest.count()).toBe(0);
    expect(await agentBySlug(body.slug)).not.toBeNull();
  });
});
