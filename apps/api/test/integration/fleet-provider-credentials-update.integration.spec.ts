import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { REDACTED_SECRET } from '../../src/approvals/route/redact-secret';
import { APPROVAL_REDEEM_HEADER } from '../../src/approvals/route/approval-gated.decorator';
import { grantKeys, seedWaitPolicy } from '../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../src/permissions/permission-cache';
import { fixtureDb } from '../helpers/action-context';
import { bootHttpApp, data } from '../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../helpers/fleet-fixtures';
import { resetDb } from '../helpers/reset-db';
import { canRunDbTests } from '../helpers/test-environment';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
const ENV = 'PROVIDER_CREDENTIAL_ENCRYPTION_KEY';
const KEY = 'abcdef0123456789'.repeat(4);
const PATH = '/api/fleet/provider-credentials';
interface Row { id: string; name: string; fingerprint: string; disabled: boolean; scope: string; }
const payload = (over: Record<string, unknown> = {}) => ({ providerId: 'openrouter', name: 'primary', key: 'sk-or-abcdef123456', ...over });

describeIntegration('GLOBAL provider credential updates (PG)', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const call = (method: 'patch' | 'delete', id: string, token = world.tokens.root) => request(server())[method](`${PATH}/${id}`).set(auth(token));
  const create = async (extra: Record<string, unknown> = {}) => data<Row>(await request(server()).post(PATH).set(auth(world.tokens.root)).send(payload(extra)).expect(201));

  beforeAll(async () => {
    const old = process.env[ENV]; process.env[ENV] = KEY;
    try { await resetDb(); app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null }); }
    finally { if (old === undefined) delete process.env[ENV]; else process.env[ENV] = old; }
    db = fixtureDb(app); world = await seedFleetHttpWorld(server(), db);
  }, 90000);
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    await db.providerCredentialIssue.deleteMany(); await db.providerCredential.deleteMany();
    await db.approvalDecision.deleteMany(); await db.approvalRequest.deleteMany(); await db.approvalPolicy.deleteMany();
    await db.fleetActivity.deleteMany(); await db.auditEntry.deleteMany();
  });

  it('AC-1/2/3/14: rotates the secret, records exact activity and audit, and returns metadata only', async () => {
    const original = await create();
    const response = await call('patch', original.id).send({ key: 'sk-or-newkey987654' }).expect(200);
    const updated = data<Row>(response);
    expect(updated.fingerprint).not.toBe(original.fingerprint);
    expect(response.body.data).not.toHaveProperty('key'); expect(response.body.data).not.toHaveProperty('encryptedKey');
    const activity = await db.fleetActivity.findMany({ where: { entityId: original.id, action: 'credential.rotated' } });
    expect(activity).toHaveLength(1); expect(activity[0].action).toBe('credential.rotated');
    expect(Object.keys(activity[0].payload as Record<string, unknown>).sort()).toEqual(['fingerprint', 'name', 'providerId', 'scope']);
    expect(await db.auditEntry.findMany({ where: { resourceId: original.id, key: 'fleet.credential.update' } })).toHaveLength(1);
  });
  it('AC-4/5/6: disables and re-enables with matching activity', async () => {
    const row = await create();
    expect(data<Row>(await call('patch', row.id).send({ disabled: true }).expect(200)).disabled).toBe(true);
    expect((await db.fleetActivity.findFirstOrThrow({ where: { entityId: row.id, action: 'credential.disabled' } })).action).toBe('credential.disabled');
    expect(data<Row>(await call('patch', row.id).send({ disabled: false }).expect(200)).disabled).toBe(false);
  });
  it('AC-7: metadata rename retains the fingerprint', async () => {
    const row = await create(); const renamed = data<Row>(await call('patch', row.id).send({ name: 'renamed' }).expect(200));
    expect(renamed).toMatchObject({ name: 'renamed', fingerprint: row.fingerprint });
  });
  it('AC-8/9: deletes and no longer lists the global row', async () => {
    const row = await create(); await call('delete', row.id).expect(200);
    expect(data<{ records: Row[] }>(await request(server()).get(PATH).set(auth(world.tokens.root)).expect(200)).records).toEqual([]);
    expect((await db.fleetActivity.findFirstOrThrow({ where: { entityId: row.id, action: 'credential.deleted' } })).action).toBe('credential.deleted');
  });
  it('AC-10: agent PATCH for a PROJECT credential is 404 before an approval request is created', async () => {
    const project = await db.project.findFirstOrThrow();
    const row = await db.providerCredential.create({ data: { scope: 'PROJECT', scopeKey: `project:${project.id}`, projectId: project.id, providerId: 'openrouter', name: 'project', encryptedKey: 'a', last4: '1234', fingerprint: '123456789abc', createdById: world.ids.root, updatedById: world.ids.root } });
    const agent = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['fleet.credential.update'], null);
    await seedWaitPolicy(db, 'fleet.credential.update', null); await app.get(PermissionCache).invalidate();
    await call('patch', row.id, agent.apiKey).send({ name: 'x' }).expect(404);
    expect(await db.approvalRequest.count()).toBe(0);
  });
  it('AC-11: agent DELETE for a REPO credential is 404 before an approval request and preserves the row', async () => {
    const project = await db.project.findFirstOrThrow();
    const repo = await db.fleetRepo.create({ data: { projectId: project.id, provider: 'github', owner: 'vault-test', name: 'repo-key', defaultBranch: 'main', createdById: world.ids.root } });
    const row = await db.providerCredential.create({ data: { scope: 'REPO', scopeKey: `repo:${repo.id}`, projectId: project.id, repoId: repo.id, providerId: 'openrouter', name: 'repo', encryptedKey: 'a', last4: '1234', fingerprint: '123456789abc', createdById: world.ids.root, updatedById: world.ids.root } });
    const agent = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['fleet.credential.delete'], null);
    await seedWaitPolicy(db, 'fleet.credential.delete', null); await app.get(PermissionCache).invalidate();
    await call('delete', row.id, agent.apiKey).expect(404);
    expect(await db.approvalRequest.count()).toBe(0);
    expect(await db.providerCredential.findUnique({ where: { id: row.id } })).not.toBeNull();
  });
  it('AC-9: delete waits for an in-flight row update and records metadata from the deleted version', async () => {
    const row = await create();
    let signalLocked!: () => void; let release!: () => void;
    const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const updating = db.$transaction(async (tx) => {
      await tx.providerCredential.update({ where: { id: row.id }, data: { name: 'concurrent-rename', fingerprint: 'abcdef123456' } });
      signalLocked(); await hold;
    });
    await locked;
    const deleting = call('delete', row.id).expect(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    release(); await updating; await deleting;
    const activity = await db.fleetActivity.findFirstOrThrow({ where: { entityId: row.id, action: 'credential.deleted' } });
    expect(activity.payload).toMatchObject({ name: 'concurrent-rename', fingerprint: 'abcdef123456' });
  });
  it('AC-12: agent rotation approval stores only the redactSecret marker', async () => {
    const row = await create(); const agent = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['fleet.credential.update'], null); await seedWaitPolicy(db, 'fleet.credential.update', null);
    await app.get(PermissionCache).invalidate();
    const pending = data<{ id: string }>(await call('patch', row.id, agent.apiKey).send({ key: 'sk-or-newkey987654' }).expect(202));
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: pending.id } })).input).toMatchObject({ patch: { key: REDACTED_SECRET } });
  });
  it('AC-13: a caller without update permission is forbidden', async () => {
    const row = await create(); await call('patch', row.id, world.tokens.dev).send({ name: 'blocked' }).expect(403);
  });
});
