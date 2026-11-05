import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { APPROVAL_REDEEM_HEADER } from '../../src/approvals/route/approval-gated.decorator';
import { REDACTED_SECRET } from '../../src/approvals/route/redact-secret';
import { grantKeys, seedWaitPolicy } from '../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../src/permissions/permission-cache';
import { grantRole } from '../../src/permissions/test-helpers/permission-fixtures';
import { fixtureDb } from '../helpers/action-context';
import { bootHttpApp, data } from '../helpers/http-app';
import { rosterFleetAgent, seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../helpers/fleet-fixtures';
import { resetDb } from '../helpers/reset-db';
import { canRunDbTests } from '../helpers/test-environment';

/**
 * Provider credential vault (C10) US-005 — the PROJECT and REPO management routes over HTTP.
 *
 * The two project routes manage a project's own PROJECT and REPO rows only: another project's
 * credential and a GLOBAL one are both 404, so an id never tells a caller that a row it may not touch
 * exists. Writes go through the same approval-gated, secret-redacting route commands as the GLOBAL
 * routes, and record activity and audit with the project on them.
 *
 * Run: cd apps/api && bun run test:db:up && KODA_DB_TESTS=1 npx vitest run
 * test/integration/project-provider-credentials.integration.spec.ts
 */
const describeIntegration = canRunDbTests() ? describe : describe.skip;

const ENCRYPTION_KEY_ENV = 'PROVIDER_CREDENTIAL_ENCRYPTION_KEY';
const MASTER_KEY = 'abcdef0123456789'.repeat(4);
const PROJECT_PATH = '/api/projects/web/provider-credentials';
const OPS_PATH = '/api/projects/ops/provider-credentials';
const GLOBAL_PATH = '/api/fleet/provider-credentials';

/** The API's own English strings, so a wording change does not silently pass. */
function apiSentence(file: string, path: readonly string[]): string {
  const catalog = JSON.parse(readFileSync(join(__dirname, `../../src/i18n/en/${file}.json`), 'utf8')) as unknown;
  const sentence = path.reduce<unknown>(
    (node, segment) => (typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[segment] : undefined),
    catalog,
  );
  if (typeof sentence !== 'string') throw new Error(`${file}: ${path.join('.')} is not a sentence`);
  return sentence;
}

interface CredentialRow {
  id: string;
  scope: string;
  projectId: string | null;
  repoId: string | null;
  providerId: string;
  name: string;
  last4: string;
  fingerprint: string;
  disabled: boolean;
  createdBy: string;
  updatedAt: string;
}

interface PendingSummary {
  id: string;
  permissionKey: string;
  projectId: string | null;
  redeem: boolean;
  status: string;
}

const body = (over: Record<string, unknown> = {}) => ({ providerId: 'openrouter', name: 'project', key: 'sk-or-abcdef123456', ...over });

/** A 404 that is the credential lookup and not, say, the route missing: pinned to the sentence. */
function expectNotFound(response: { body: { ret?: number; message?: string } }): void {
  expect(response.body.ret).toBe(404);
  expect(response.body.message).toBe(apiSentence('fleet', ['providerCredentials', 'notFound', '404']));
}

describeIntegration('PROJECT and REPO provider credentials API (PG)', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let previousKey: string | undefined;

  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const root = () => auth(world.tokens.root);
  /** `viewer` gains the project-admin role on `web`: the story's "Project Admin" actor. */
  const projectAdmin = () => auth(world.tokens.viewer);
  const create = (payload: Record<string, unknown>, token = world.tokens.viewer, path = PROJECT_PATH, redeem?: string) => {
    const call = request(server()).post(path).set(auth(token)).send(payload);
    return redeem === undefined ? call : call.set(APPROVAL_REDEEM_HEADER, redeem);
  };
  const list = (token = world.tokens.viewer, path = PROJECT_PATH) => request(server()).get(path).set(auth(token));
  const patch = (id: string, payload: Record<string, unknown>, token = world.tokens.viewer, path = PROJECT_PATH) =>
    request(server()).patch(`${path}/${id}`).set(auth(token)).send(payload);
  const remove = (id: string, token = world.tokens.viewer, path = PROJECT_PATH) =>
    request(server()).delete(`${path}/${id}`).set(auth(token));
  const rows = () => db.providerCredential.findMany();

  beforeAll(async () => {
    previousKey = process.env[ENCRYPTION_KEY_ENV];
    process.env[ENCRYPTION_KEY_ENV] = MASTER_KEY;
    try {
      await resetDb();
      app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    } finally {
      if (previousKey === undefined) delete process.env[ENCRYPTION_KEY_ENV];
      else process.env[ENCRYPTION_KEY_ENV] = previousKey;
    }
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    await grantRole(db, { type: 'USER', id: world.ids.viewer }, 'project-admin', world.projectId);
    await app.get(PermissionCache).invalidate();
  }, 90_000);

  afterAll(async () => { await app?.close(); });

  beforeEach(async () => {
    await db.providerCredentialIssue.deleteMany();
    await db.providerCredential.deleteMany();
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
    await db.fleetActivity.deleteMany();
    await db.auditEntry.deleteMany();
  });

  it('AC-1: a Project Admin creates a PROJECT key without a repoId', async () => {
    const created = data<CredentialRow>(await create(body()).expect(201));

    expect(created).toMatchObject({
      scope: 'PROJECT', projectId: world.projectId, repoId: null, providerId: 'openrouter', last4: '3456',
    });
    // An explicit `null` repoId is the same request: the scope belongs to the body only when it names a repo.
    const nullRepo = data<CredentialRow>(await create(body({ providerId: 'anthropic', repoId: null })).expect(201));
    expect(nullRepo).toMatchObject({ scope: 'PROJECT', projectId: world.projectId, repoId: null });
    expect(await rows()).toHaveLength(2);
  });

  it('AC-2: a repoId of a repo in the project creates a REPO key', async () => {
    const created = data<CredentialRow>(await create(body({ repoId: world.repoId })).expect(201));

    expect(created).toMatchObject({ scope: 'REPO', projectId: world.projectId, repoId: world.repoId });
    expect((await rows())[0]).toMatchObject({ scope: 'REPO', repoId: world.repoId, scopeKey: `repo:${world.repoId}` });
  });

  it('AC-3: a repoId of another project answers 404 fleet.repos and writes nothing', async () => {
    const response = await create(body({ repoId: world.foreignRepoId })).expect(404);

    expect(response.body.ret).toBe(404);
    expect(response.body.message).toBe(apiSentence('fleet', ['repos', '404']));
    expect(await rows()).toEqual([]);
  });

  it('AC-4: a Developer is refused the create and writes nothing', async () => {
    await create(body(), world.tokens.dev).expect(403);

    expect(await rows()).toEqual([]);
  });

  it('AC-5: a Developer reads the project keys as metadata with no key field', async () => {
    await create(body()).expect(201);
    await create(body({ providerId: 'anthropic', repoId: world.repoId })).expect(201);

    const response = await list(world.tokens.dev).expect(200);
    const listed = data<{ records: CredentialRow[] }>(response);

    expect(listed.records).toHaveLength(2);
    for (const record of listed.records) {
      expect(record).not.toHaveProperty('key');
      expect(record).not.toHaveProperty('encryptedKey');
    }
    expect(JSON.stringify(response.body)).not.toContain('sk-or-abcdef123456');
  });

  it('AC-6: the list is the project PROJECT and REPO rows, never a GLOBAL or another project row', async () => {
    const project = data<CredentialRow>(await create(body()).expect(201));
    const repo = data<CredentialRow>(await create(body({ providerId: 'anthropic', repoId: world.repoId })).expect(201));
    await create(body({ providerId: 'deepseek' }), world.tokens.root, GLOBAL_PATH).expect(201);
    await create(body({ providerId: 'mistral' }), world.tokens.root, OPS_PATH).expect(201);

    const listed = data<{ records: CredentialRow[] }>(await list().expect(200));

    expect(listed.records.map(({ id }) => id).sort()).toEqual([project.id, repo.id].sort());
    expect(listed.records.every(({ projectId }) => projectId === world.projectId)).toBe(true);
  });

  it('AC-7: a PATCH of another project credential answers 404 and changes nothing', async () => {
    const foreign = data<CredentialRow>(await create(body({ name: 'ops key' }), world.tokens.root, OPS_PATH).expect(201));

    expectNotFound(await patch(foreign.id, { name: 'hijacked' }).expect(404));

    expect(await db.providerCredential.findUniqueOrThrow({ where: { id: foreign.id } })).toMatchObject({ name: 'ops key' });
  });

  it('AC-8: a PATCH of a GLOBAL credential id answers 404', async () => {
    const global = data<CredentialRow>(await create(body({ name: 'global key' }), world.tokens.root, GLOBAL_PATH).expect(201));

    expectNotFound(await patch(global.id, { name: 'hijacked' }).expect(404));

    expect(await db.providerCredential.findUniqueOrThrow({ where: { id: global.id } })).toMatchObject({ name: 'global key' });
  });

  it('AC-9: a DELETE of another project credential answers 404 and leaves the row in place', async () => {
    const foreign = data<CredentialRow>(await create(body(), world.tokens.root, OPS_PATH).expect(201));

    expectNotFound(await remove(foreign.id).expect(404));

    expect(await db.providerCredential.findUnique({ where: { id: foreign.id } })).not.toBeNull();
  });

  it('AC-10: a PATCH with a new key rotates it and records credential.rotated in the project', async () => {
    const created = data<CredentialRow>(await create(body()).expect(201));

    const rotated = data<CredentialRow>(await patch(created.id, { key: 'sk-or-zyxwvu987654' }).expect(200));

    expect(rotated.fingerprint).not.toBe(created.fingerprint);
    expect(rotated.last4).toBe('7654');
    const activity = await db.fleetActivity.findMany({ where: { entityId: created.id, action: 'credential.rotated' } });
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      entityType: 'provider_credential', entityId: created.id, projectId: world.projectId,
    });
    expect(Object.keys(activity[0].payload as Record<string, unknown>).sort()).toEqual(['fingerprint', 'name', 'providerId', 'scope']);
    const audit = await db.auditEntry.findMany({ where: { resourceId: created.id, key: 'project.credential.update' } });
    expect(audit).toHaveLength(1);
  });

  it('AC-11: a DELETE records credential.deleted with the project id', async () => {
    const created = data<CredentialRow>(await create(body()).expect(201));

    await remove(created.id).expect(200);

    expect(await db.providerCredential.findUnique({ where: { id: created.id } })).toBeNull();
    const activity = await db.fleetActivity.findMany({ where: { entityId: created.id, action: 'credential.deleted' } });
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ entityType: 'provider_credential', projectId: world.projectId });
    expect(await db.auditEntry.findMany({ where: { resourceId: created.id, key: 'project.credential.delete' } })).toHaveLength(1);
  });

  it('AC-12: an agent create stores an approval request whose key is the redaction marker', async () => {
    const agent = await seedFleetHttpAgent(server(), world.tokens.root);
    await rosterFleetAgent(db, agent.id, world.projectId);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.credential.create'], world.projectId);
    await seedWaitPolicy(db, 'project.credential.create', world.projectId);
    await app.get(PermissionCache).invalidate();

    const summary = data<PendingSummary>(await create(body(), agent.apiKey).expect(202));

    expect(summary).toMatchObject({
      permissionKey: 'project.credential.create', projectId: world.projectId, redeem: true, status: 'pending',
    });
    expect(await rows()).toEqual([]);
    const stored = await db.approvalRequest.findUniqueOrThrow({ where: { id: summary.id } });
    expect(stored.input).toMatchObject({ projectId: world.projectId, providerId: 'openrouter', name: 'project', key: REDACTED_SECRET });
    expect(JSON.stringify(stored)).not.toContain('sk-or-abcdef123456');
  });

  it('extra: redeeming an approved agent create seals the resubmitted key into the project', async () => {
    const agent = await seedFleetHttpAgent(server(), world.tokens.root);
    await rosterFleetAgent(db, agent.id, world.projectId);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.credential.create'], world.projectId);
    await seedWaitPolicy(db, 'project.credential.create', world.projectId);
    await app.get(PermissionCache).invalidate();
    const summary = data<PendingSummary>(await create(body(), agent.apiKey).expect(202));
    await request(server()).post(`/api/approvals/${summary.id}/decisions`).set(root()).send({ decision: 'approve' }).expect(200);

    const created = data<CredentialRow>(
      await create(body({ key: 'sk-or-zyxwvu987654' }), agent.apiKey, PROJECT_PATH, summary.id).expect(201),
    );

    expect(created).toMatchObject({ scope: 'PROJECT', projectId: world.projectId, last4: '7654' });
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: summary.id } })).status).toBe('executed');
  });

  it('extra: a second key for the same provider at the same scope answers 409', async () => {
    await create(body()).expect(201);

    const response = await create(body()).expect(409);

    expect(response.body.ret).toBe(409);
    expect(response.body.message).toBe(apiSentence('fleet', ['providerCredentials', 'duplicate', '409']));
    expect(await rows()).toHaveLength(1);
  });

  it('extra: disabling and re-enabling a project key records both actions in the project', async () => {
    const created = data<CredentialRow>(await create(body()).expect(201));

    expect(data<CredentialRow>(await patch(created.id, { disabled: true }).expect(200)).disabled).toBe(true);
    expect(data<CredentialRow>(await patch(created.id, { disabled: false }).expect(200)).disabled).toBe(false);

    const actions = await db.fleetActivity.findMany({
      where: { entityId: created.id, action: { in: ['credential.disabled', 'credential.enabled'] } },
      orderBy: { createdAt: 'asc' },
    });
    expect(actions.map(({ action, projectId }) => ({ action, projectId }))).toEqual([
      { action: 'credential.disabled', projectId: world.projectId },
      { action: 'credential.enabled', projectId: world.projectId },
    ]);
  });

  it('AC-15: the GLOBAL route keeps listing only GLOBAL rows after PROJECT and REPO keys exist', async () => {
    await create(body()).expect(201);
    await create(body({ providerId: 'anthropic', repoId: world.repoId })).expect(201);
    const global = data<CredentialRow>(await create(body({ providerId: 'deepseek' }), world.tokens.root, GLOBAL_PATH).expect(201));

    const listed = data<{ records: CredentialRow[] }>(await list(world.tokens.root, GLOBAL_PATH).expect(200));

    expect(listed.records.map(({ id, scope }) => ({ id, scope }))).toEqual([{ id: global.id, scope: 'GLOBAL' }]);
  });
});
