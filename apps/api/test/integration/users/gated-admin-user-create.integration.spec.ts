import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { APPROVAL_REDEEM_HEADER } from '../../../src/approvals/route/approval-gated.decorator';
import { grantKeys, seedWaitPolicy } from '../../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { seedFleetHttpAgent } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

/**
 * Permissions P3 `gate-secret` (US-007) — the admin user create redeems instead of executing.
 *
 * The temporary password a global admin sets is a credential: an agent that holds `user.create` and
 * meets a wait policy opens a request whose stored input (and hash) carries only the identity it
 * creates. Approving it runs nothing; the requester redeems it by re-sending the body, and the
 * password in that re-sent body is the one that lands — only email and name are bound into the stored
 * hash. A human executes at once and opens no request at all.
 *
 * The nax sandbox withholds host Postgres; the suite skips there and runs on the host with
 * `KODA_DB_TESTS=1` (`bun run test:scoped test/integration/users/gated-admin-user-create.integration.spec.ts`).
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
/** A created user, as the route answers it (no password, no hash). */
interface CreatedUser { id: string; email: string; name: string }
/** The approval request as the detail route renders it. */
interface RequestDetail {
  status: string;
  input: Record<string, unknown>;
  result: Record<string, unknown> | null;
}

describeIntegration('gated admin user create (US-007)', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let rootToken: string;
  let actor: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let serial = 0;

  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const rootAuth = () => auth(rootToken);
  const newEmail = () => `gated-user-${++serial}@koda.test`;
  /** The full create body: the DTO's password complexity is satisfied on purpose. */
  const createBody = (email: string, password = 'StrongPass123!') => ({ email, name: 'New User', password });
  const create = (body: object, options: { token?: string; redeem?: string } = {}) => {
    const call = request(server()).post('/api/admin/users').set(auth(options.token ?? actor.apiKey)).send(body);
    return options.redeem === undefined ? call : call.set(APPROVAL_REDEEM_HEADER, options.redeem);
  };
  const login = (email: string, password: string) =>
    request(server()).post('/api/auth/login').send({ email, password });
  const approvalRequest = (id: string) =>
    request(server()).get(`/api/approvals/${id}`).set(rootAuth());
  const pending = (res: request.Response) => {
    expect(res.status).toBe(202);
    return data<PendingSummary>(res);
  };
  const approve = async (id: string) => data<{ status: string }>(
    await request(server()).post(`/api/approvals/${id}/decisions`).set(rootAuth())
      .send({ decision: 'approve' }).expect(200),
  );
  const requestRow = (id: string) => db.approvalRequest.findUniqueOrThrow({ where: { id } });
  const userByEmail = (email: string) => db.user.findUnique({ where: { email } });
  /** A policy for *every* principal type, so a human caller meets one too. */
  const seedPolicyForAnyPrincipal = (key: string) => db.approvalPolicy.create({
    data: {
      selector: `*|${key}|all`, projectId: null, permissionPattern: key, principalType: null,
      mode: 'agent', updatedByType: 'SYSTEM', updatedById: 'test',
    },
  });
  /** The API's own English approvals catalog, so a wording change does not silently pass. */
  const message = (key: string, status: string) => {
    const catalog = JSON.parse(
      readFileSync(join(__dirname, '../../../src/i18n/en/approvals.json'), 'utf8'),
    ) as Record<string, Record<string, string>>;
    return catalog[key][status];
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    rootToken = data<{ accessToken: string }>(
      await request(server()).post('/api/auth/register')
        .send({ email: 'create-root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201),
    ).accessToken;
    actor = await seedFleetHttpAgent(server(), rootToken);
    // The requester holds precisely the key it exercises, in the global scope.
    await grantKeys(db, { type: 'AGENT', id: actor.id }, ['user.create'], null);
    await app.get(PermissionCache).invalidate();
  }, 60_000);

  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
  });

  afterAll(async () => { await app?.close(); });

  it('AC-1: the create waits on a redeem request and writes no user', async () => {
    await seedWaitPolicy(db, 'user.create', null);
    const email = newEmail();

    const summary = pending(await create(createBody(email)));

    expect(summary).toMatchObject({ permissionKey: 'user.create', projectId: null, redeem: true });
    expect(await userByEmail(email)).toBeNull();
  });

  it('AC-2: the request detail carries the email and name, and no password anywhere', async () => {
    await seedWaitPolicy(db, 'user.create', null);
    const email = newEmail();
    const summary = pending(await create(createBody(email)));

    const detail = data<RequestDetail>(await approvalRequest(summary.id).expect(200));

    expect(detail.input).toEqual({ user: { email, name: 'New User' } });
    expect(JSON.stringify(detail.input)).not.toContain('StrongPass123!');
  });

  it('AC-3: redeeming an approved create answers the user and stores no password', async () => {
    await seedWaitPolicy(db, 'user.create', null);
    const email = newEmail();
    const body = createBody(email);
    const summary = pending(await create(body));
    await approve(summary.id);

    const res = await create(body, { redeem: summary.id }).expect(201);

    expect(data<CreatedUser>(res).email).toBe(email);
    expect((await requestRow(summary.id)).status).toBe('executed');
    // Neither the frozen input, the stored result, nor any audit summary ever held the password.
    const row = await requestRow(summary.id);
    const audits = await db.auditEntry.findMany({ where: { resourceType: 'user' } });
    expect(JSON.stringify({ input: row.input, result: row.result })).not.toContain('StrongPass123!');
    expect(audits.length).toBeGreaterThan(0);
    for (const entry of audits) expect(entry.summary ?? '').not.toContain('StrongPass123!');
  });

  it('AC-4: the password submitted with the request authenticates the created user', async () => {
    await seedWaitPolicy(db, 'user.create', null);
    const email = newEmail();
    const body = createBody(email);
    const summary = pending(await create(body));
    await approve(summary.id);
    await create(body, { redeem: summary.id }).expect(201);

    await login(email, 'StrongPass123!').expect(200);
  });

  it('AC-5: the password re-sent at redemption is the one that lands', async () => {
    await seedWaitPolicy(db, 'user.create', null);
    const email = newEmail();
    const summary = pending(await create(createBody(email)));
    await approve(summary.id);

    // Only email and name are bound into the stored hash, so a new password is the same request.
    await create(createBody(email, 'OtherPass456!'), { redeem: summary.id }).expect(201);

    await login(email, 'OtherPass456!').expect(200);
    // The password frozen at request time never became the account's.
    expect(await login(email, 'StrongPass123!')).toHaveProperty('status', 401);
  });

  it('AC-6: redeeming with a different email answers redeemMismatch and creates neither user', async () => {
    await seedWaitPolicy(db, 'user.create', null);
    const email = newEmail();
    const otherEmail = newEmail();
    const summary = pending(await create(createBody(email)));
    await approve(summary.id);

    const res = await create(createBody(otherEmail), { redeem: summary.id }).expect(409);

    expect(res.body.ret).toBe(409);
    expect(res.body.message).toBe(message('redeemMismatch', '409'));
    expect(await userByEmail(email)).toBeNull();
    expect(await userByEmail(otherEmail)).toBeNull();
    // Nothing ran, so the request is still the approved one it was.
    expect((await requestRow(summary.id)).status).toBe('approved');
  });

  it('AC-7: a human create under a wait policy executes at once and opens no request', async () => {
    await seedPolicyForAnyPrincipal('user.create');
    const email = newEmail();

    const res = await create(createBody(email), { token: rootToken }).expect(201);

    expect(data<CreatedUser>(res).email).toBe(email);
    expect(await db.approvalRequest.count()).toBe(0);
    expect(await userByEmail(email)).not.toBeNull();
  });
});
