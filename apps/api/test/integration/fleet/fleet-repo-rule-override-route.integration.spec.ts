import { canRunDbTests } from '../../helpers/test-environment';
/**
 * The `GET/PUT/DELETE /api/fleet/repos/:id/rule-override` routes (#370): the per-repo rule
 * override storage. One global key gates all three, the two writes are approval-gated, and an
 * invalid body is refused before the gate can open an approval request.
 *
 * Run: cd apps/api && bun run test:db:up && KODA_DB_TESTS=1 bunx vitest run test/integration/fleet/fleet-repo-rule-override-route.integration.spec.ts
 */
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { ruleOverrideSha256, validateRuleOverride } from '../../../src/fleet/repos/rule-override';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;
const KEY = 'fleet.repo.rules.configure';

const RULES = [
  { path: 'api.md', content: 'always answer with the summary' },
  { path: 'ci.md', content: 'run the checks before the review' },
];
const CONTEXT = { content: 'the project answers in english', mode: 'append' as const };
const BODY = { rules: RULES, rulesMode: 'merge' as const, context: CONTEXT };
const SHA = ruleOverrideSha256(validateRuleOverride(BODY));

interface Summary { sha256: string; ruleFiles: number; rulesMode: string; contextMode: string | null; updatedAt: string }
interface RepoBody { id: string; ruleOverride: Summary | null }
interface OverrideBody {
  rules: { path: string; content: string }[];
  rulesMode: string;
  context: { content: string; mode: string } | null;
  sha256: string;
  updatedAt: string;
}
interface Pending { id: string; permissionKey: string; projectId: string | null }
interface Decided { status: string; result: unknown }

describeIntegration('fleet repo rule override route (PG)', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let seq = 0;
  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const put = (id: string, body: unknown, token?: string) =>
    request(server()).put(`/api/fleet/repos/${id}/rule-override`).set(auth(token ?? world.tokens.root)).send(body as object);
  const get = (id: string, token?: string) =>
    request(server()).get(`/api/fleet/repos/${id}/rule-override`).set(auth(token ?? world.tokens.root));
  const del = (id: string, token?: string) =>
    request(server()).delete(`/api/fleet/repos/${id}/rule-override`).set(auth(token ?? world.tokens.root));

  /** A fresh repo on the seeded project, so no case reads a row another case wrote. */
  const repo = (over: Record<string, unknown> = {}) => db.fleetRepo.create({
    data: {
      projectId: world.projectId, provider: 'github', owner: 'acme', name: `rules-${++seq}`,
      defaultBranch: 'main', githubInstallationId: BigInt(77), createdById: world.ids.root, ...over,
    },
  });

  /** The override rows of one repo, so a case never reads another case's row. */
  const overrides = (repoId: string) => db.fleetRepoRuleOverride.count({ where: { repoId } });
  const approve = async (id: string) => data<Decided>(
    await request(server()).post(`/api/approvals/${id}/decisions`).set(auth(world.tokens.root))
      .send({ decision: 'approve' }).expect(200),
  );

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    // The rules key is its own global key, so it is granted here rather than read off a seeded role.
    await grantKeys(db, { type: 'USER', id: world.ids.root }, [KEY], null);
    // The agent holds the same key globally, so it reaches the handler and waits for an approval.
    await grantKeys(db, { type: 'AGENT', id: agent.id }, [KEY], null);
    // The dev user holds the repo read key but not the rules key, so it can be told apart from a
    // caller that may read the repo but may not change its rules.
    await grantKeys(db, { type: 'USER', id: world.ids.dev }, ['fleet.repo.read'], null);
    await app.get(PermissionCache).invalidate();
  }, 90_000);

  afterAll(async () => { await app?.close(); });

  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
  });

  it('AC-1: a user holding the key globally stores the override and answers with its hash', async () => {
    const target = await repo();
    const body = data<RepoBody>(await put(target.id, BODY).expect(200));

    expect(body.id).toBe(target.id);
    expect(body.ruleOverride).toMatchObject({ sha256: SHA, ruleFiles: 2, rulesMode: 'merge', contextMode: 'append' });
    expect(await db.fleetRepoRuleOverride.findUniqueOrThrow({ where: { repoId: target.id } })).toMatchObject({
      sha256: SHA, ruleFiles: 2, rulesMode: 'merge', contextMode: 'append', contextContent: CONTEXT.content,
    });
  });

  it('AC-2: the read returns the same rules, rulesMode and context', async () => {
    const target = await repo();
    await put(target.id, BODY).expect(200);

    const body = data<OverrideBody>(await get(target.id).expect(200));
    expect(body).toMatchObject({
      rules: RULES, rulesMode: 'merge', context: CONTEXT, sha256: SHA,
    });
    expect(body.updatedAt).toEqual(expect.any(String));
  });

  it('AC-3: the repo listing carries the override summary', async () => {
    const target = await repo();
    await put(target.id, BODY).expect(200);

    const page = data<{ records: RepoBody[] }>(
      await request(server()).get('/api/fleet/repos?size=100').set(auth(world.tokens.root)).expect(200),
    );
    const listed = page.records.find((record) => record.id === target.id);
    expect(listed?.ruleOverride).toMatchObject({
      sha256: SHA, ruleFiles: 2, rulesMode: 'merge', contextMode: 'append',
    });
    expect(listed?.ruleOverride?.updatedAt).toEqual(expect.any(String));
  });

  it('AC-4: a clear answers 200 and the read afterwards is null', async () => {
    const target = await repo();
    await put(target.id, BODY).expect(200);

    await del(target.id).expect(200);
    expect(data(await get(target.id).expect(200))).toBeNull();
    expect(await overrides(target.id)).toBe(0);
  });

  it('AC-5: a user without the key is refused with 403 and nothing is stored', async () => {
    const target = await repo();
    await put(target.id, BODY, world.tokens.dev).expect(403);

    expect(await overrides(target.id)).toBe(0);
    expect(await db.approvalRequest.count()).toBe(0);
  });

  it('AC-6: an agent with no approval policy waits with 202 and stores nothing', async () => {
    const target = await repo();
    const summary = data<Pending>(await put(target.id, BODY, agent.apiKey).expect(202));

    expect(summary).toMatchObject({ permissionKey: KEY, projectId: null });
    expect(await overrides(target.id)).toBe(0);
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: summary.id } })).status).toBe('pending');
  });

  it('AC-7: approving that request stores the override', async () => {
    const target = await repo();
    const summary = data<Pending>(await put(target.id, BODY, agent.apiKey).expect(202));

    expect((await approve(summary.id)).status).toBe('executed');
    expect(await db.fleetRepoRuleOverride.findUniqueOrThrow({ where: { repoId: target.id } })).toMatchObject({
      sha256: SHA, ruleFiles: 2, rulesMode: 'merge',
    });
  });

  it('AC-8: a reader without the rules key is refused on the read and the clear', async () => {
    const target = await repo();
    await put(target.id, BODY).expect(200);

    await get(target.id, world.tokens.dev).expect(403);
    await del(target.id, world.tokens.dev).expect(403);
    expect(await overrides(target.id)).toBe(1);
  });

  it.each(['put', 'get', 'delete'] as const)('AC-9: %s on an unknown repo answers 404 fleet.repos', async (method) => {
    const call = method === 'put' ? put('no-such-repo', BODY) : method === 'get' ? get('no-such-repo') : del('no-such-repo');
    const res = await call.expect(404);
    // The domain refusal, so a missing route's "Cannot PUT ..." body does not answer this AC.
    expect(JSON.stringify(res.body)).toContain('Fleet repository not found');
  });

  it.each(['put', 'delete'] as const)('AC-9: an agent holding the key gets 404 on %s against an unknown repo', async (method) => {
    // The agent passes the guard and reaches the handler, so the repo lookup has to happen before
    // the approval gate: a request for a repo that cannot exist is a 404, not a 202.
    const call = method === 'put' ? put('no-such-repo', BODY, agent.apiKey) : del('no-such-repo', agent.apiKey);
    const res = await call.expect(404);
    expect(JSON.stringify(res.body)).toContain('Fleet repository not found');
    // No approval request was opened for a write that could never run.
    expect(await db.approvalRequest.count()).toBe(0);
  });

  it.each([
    ['a path outside the rules directory', { rules: [{ path: '../x.md', content: 'x' }] }, 'path'],
    ['a duplicate path', { rules: [{ path: 'api.md', content: 'x' }, { path: 'api.md', content: 'y' }] }, 'duplicatePath'],
    ['an oversized file', { rules: [{ path: 'api.md', content: 'x'.repeat(32_769) }] }, 'content'],
    ['a NUL in the content', { rules: [{ path: 'api.md', content: 'a\0b' }] }, 'content'],
    ['an unknown rules mode', { rules: [{ path: 'api.md', content: 'x' }], rulesMode: 'append' }, 'rulesMode'],
    ['nothing in it', { rules: [] }, 'empty'],
  ])('AC-15: %s answers 400 with its reason before the approval gate', async (_label, body, reason) => {
    const target = await repo();

    const res = await put(target.id, body, agent.apiKey).expect(400);
    expect(String(res.body.message)).toContain(`Invalid rule override: ${reason}`);
    // No approval request was opened and nothing was stored.
    expect(await db.approvalRequest.count()).toBe(0);
    expect(await overrides(target.id)).toBe(0);
  });
});
