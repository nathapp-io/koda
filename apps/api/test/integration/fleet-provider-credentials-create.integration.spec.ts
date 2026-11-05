import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { APPROVAL_REDEEM_HEADER } from '../../src/approvals/route/approval-gated.decorator';
import { REDACTED_SECRET } from '../../src/approvals/route/redact-secret';
import { grantKeys, seedWaitPolicy } from '../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../src/permissions/permission-cache';
import { fixtureDb } from '../helpers/action-context';
import { bootHttpApp, data } from '../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../helpers/fleet-fixtures';
import { resetDb } from '../helpers/reset-db';
import { canRunDbTests } from '../helpers/test-environment';

/**
 * Provider credential vault (C10) US-003 — the GLOBAL management routes over HTTP.
 *
 * Every answer is write-only metadata: the sealed key never leaves the service, the create records its
 * activity and audit entry in the same transaction, and an agent that holds `fleet.credential.create`
 * waits on an approval request whose frozen input carries `redactSecret(key)` instead of the key.
 *
 * The vault is off unless `PROVIDER_CREDENTIAL_ENCRYPTION_KEY` is set, so the suite sets it for its
 * boot (and restores the previous value); AC-7 boots a second app with the key unset.
 *
 * Run: cd apps/api && bun run test:db:up && KODA_DB_TESTS=1 npx vitest run test/integration/fleet-provider-credentials-create.integration.spec.ts
 */
const describeIntegration = canRunDbTests() ? describe : describe.skip;

const ENCRYPTION_KEY_ENV = 'PROVIDER_CREDENTIAL_ENCRYPTION_KEY';
const MASTER_KEY = 'abcdef0123456789'.repeat(4);

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

const CREATE = '/api/fleet/provider-credentials';
const body = (over: Record<string, unknown> = {}) => ({ providerId: 'openrouter', name: 'fleet', key: 'sk-or-abcdef123456', ...over });

describeIntegration('GLOBAL provider credentials API (PG)', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let previousKey: string | undefined;

  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const root = () => auth(world.tokens.root);
  const create = (payload: Record<string, unknown>, token = world.tokens.root, redeem?: string) => {
    const call = request(server()).post(CREATE).set(auth(token)).send(payload);
    return redeem === undefined ? call : call.set(APPROVAL_REDEEM_HEADER, redeem);
  };
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

  it('AC-1: a global admin creates a GLOBAL key and reads back its last four characters', async () => {
    const created = data<CredentialRow>(await create(body()).expect(201));

    expect(created).toMatchObject({ scope: 'GLOBAL', projectId: null, repoId: null, providerId: 'openrouter', last4: '3456' });
    expect(await rows()).toHaveLength(1);
  });

  it('AC-2: the create answer carries neither the key nor its ciphertext', async () => {
    const response = await create(body()).expect(201);

    expect(response.body.data).not.toHaveProperty('key');
    expect(response.body.data).not.toHaveProperty('encryptedKey');
    expect(JSON.stringify(response.body)).not.toContain('sk-or-abcdef123456');
  });

  it('AC-3: the list returns the created row as metadata only', async () => {
    const created = data<CredentialRow>(await create(body()).expect(201));

    const listed = data<{ records: CredentialRow[] }>(await request(server()).get(CREATE).set(root()).expect(200));

    expect(listed.records).toHaveLength(1);
    expect(listed.records[0]).toMatchObject({
      id: created.id, name: 'fleet', last4: '3456', fingerprint: created.fingerprint, disabled: false, providerId: 'openrouter',
    });
    expect(listed.records[0].fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(listed.records[0]).not.toHaveProperty('key');
    expect(listed.records[0]).not.toHaveProperty('encryptedKey');
  });

  it('AC-4: a project developer without fleet.credential.create is refused and writes nothing', async () => {
    await create(body(), world.tokens.dev).expect(403);

    expect(await rows()).toEqual([]);
  });

  it('AC-5: an invalid providerId answers 400 naming providerId', async () => {
    const response = await create(body({ providerId: 'Bad Id' })).expect(400);

    expect(response.body.ret).toBe(-2);
    expect(Object.keys((response.body as { errors?: Record<string, unknown> }).errors ?? {})).toContain('providerId');
    expect(await rows()).toEqual([]);
  });

  it('AC-6: a second key for the same provider answers 409 fleet.providerCredentials.duplicate', async () => {
    await create(body()).expect(201);

    const response = await create(body()).expect(409);

    expect(response.body.ret).toBe(409);
    expect(response.body.message).toBe(apiSentence('fleet', ['providerCredentials', 'duplicate', '409']));
    expect(await rows()).toHaveLength(1);
  });

  it('AC-8: the create records exactly one credential.created activity row with a secret-free payload', async () => {
    const created = data<CredentialRow>(await create(body()).expect(201));

    const activities = await db.fleetActivity.findMany({ where: { entityId: created.id } });

    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      action: 'credential.created', entityType: 'provider_credential', entityId: created.id, projectId: null,
      actorType: 'USER', actorId: world.ids.root,
    });
    expect(Object.keys(activities[0].payload as Record<string, unknown>).sort())
      .toEqual(['fingerprint', 'name', 'providerId', 'scope']);
  });

  it('AC-9: the create records one audit entry under fleet.credential.create', async () => {
    const created = data<CredentialRow>(await create(body()).expect(201));

    const entries = await db.auditEntry.findMany({ where: { resourceId: created.id } });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ key: 'fleet.credential.create', resourceType: 'provider_credential', projectId: null });
  });

  it('AC-10/AC-11: an agent holding the key waits on a request whose frozen key is the redaction marker', async () => {
    const agent = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['fleet.credential.create'], null);
    await seedWaitPolicy(db, 'fleet.credential.create', null);
    await app.get(PermissionCache).invalidate();

    const summary = data<PendingSummary>(await create(body(), agent.apiKey).expect(202));

    expect(summary).toMatchObject({ permissionKey: 'fleet.credential.create', projectId: null, redeem: true, status: 'pending' });
    expect(await rows()).toEqual([]);
    const stored = await db.approvalRequest.findUniqueOrThrow({ where: { id: summary.id } });
    expect(stored.input).toMatchObject({ providerId: 'openrouter', name: 'fleet', key: REDACTED_SECRET });
    expect(JSON.stringify(stored)).not.toContain('sk-or-abcdef123456');
  });

  it('AC-12: redeeming the approved request seals the key resubmitted in the redeem body', async () => {
    const agent = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['fleet.credential.create'], null);
    await seedWaitPolicy(db, 'fleet.credential.create', null);
    await app.get(PermissionCache).invalidate();
    const summary = data<PendingSummary>(await create(body(), agent.apiKey).expect(202));
    await request(server()).post(`/api/approvals/${summary.id}/decisions`).set(root()).send({ decision: 'approve' }).expect(200);

    const created = data<CredentialRow>(await create(body({ key: 'sk-or-zyxwvu987654' }), agent.apiKey, summary.id).expect(201));

    expect(created.last4).toBe('7654');
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: summary.id } })).status).toBe('executed');
  });
});

describeIntegration('GLOBAL provider credentials API with the vault off (PG)', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let previousKey: string | undefined;
  let token: string;

  const server = () => app.getHttpServer();

  beforeAll(async () => {
    previousKey = process.env[ENCRYPTION_KEY_ENV];
    delete process.env[ENCRYPTION_KEY_ENV];
    try {
      await resetDb();
      app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
      db = fixtureDb(app);
      // The first registered user is the installation owner, so it holds fleet.credential.create.
      token = data<{ accessToken: string }>(
        await request(server()).post('/api/auth/register').send({ email: 'vault-off@koda.test', name: 'Vault Off', password: 'Admin1234!Aa' }).expect(201),
      ).accessToken;
    } finally {
      if (previousKey === undefined) delete process.env[ENCRYPTION_KEY_ENV];
      else process.env[ENCRYPTION_KEY_ENV] = previousKey;
    }
  }, 90_000);

  afterAll(async () => { await app?.close(); });

  it('AC-7: a create with the vault off answers 503 fleet.providerCredentials.vaultOff', async () => {
    const response = await request(server()).post(CREATE).set({ Authorization: `Bearer ${token}` })
      .send(body()).expect(503);

    expect(response.body.ret).toBe(503);
    expect(response.body.message).toBe(apiSentence('fleet', ['providerCredentials', 'vaultOff', '503']));
    expect(await db.providerCredential.count()).toBe(0);
  });
});
