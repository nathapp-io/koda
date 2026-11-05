import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import type { RunnerCapabilities } from '../../src/fleet/common/protocol';
import { PROVIDER_KEY_SUMMARY_PAGE_SIZE } from '../../src/fleet/provider-credentials/provider-credential.domain';
import { fixtureDb } from '../helpers/action-context';
import { enrollRunner, FLEET_CAPS, seedFleetHttpWorld, type FleetHttpWorld } from '../helpers/fleet-fixtures';
import { bootHttpApp, data, TEST_PASSWORD } from '../helpers/http-app';
import { resetDb } from '../helpers/reset-db';
import { canRunDbTests } from '../helpers/test-environment';

/**
 * Provider credential vault (C10) US-007 — the admin credential board's `kodaKeys` column over HTTP.
 *
 * The board is a global admin read (`GET /api/fleet/credential-board`, key `fleet.credential.read`).
 * This story adds two things to its answer: the active GLOBAL keys koda holds, as metadata only, and
 * each runner's `providerVault` readiness. The subscription itself (PROJECT and REPO keys, disabled
 * rows, a vault that is off) must never leak into a column every global admin can read.
 *
 * The vault is off unless `PROVIDER_CREDENTIAL_ENCRYPTION_KEY` is set, so this suite sets it for its
 * boot and restores the previous value; the last case boots a second app with the key unset and a
 * GLOBAL row already in the table, which is what "the vault is off" looks like in production.
 *
 * Run: cd apps/api && bun run test:db:up && KODA_DB_TESTS=1 npx vitest run test/integration/provider-credential-board.integration.spec.ts
 */
const describeIntegration = canRunDbTests() ? describe : describe.skip;

const ENCRYPTION_KEY_ENV = 'PROVIDER_CREDENTIAL_ENCRYPTION_KEY';
const MASTER_KEY = 'abcdef0123456789'.repeat(4);
const BOARD = '/api/fleet/credential-board';
const GLOBAL_KEYS = '/api/fleet/provider-credentials';
const PROJECT_KEYS = '/api/projects/web/provider-credentials';

interface CredentialRow {
  id: string;
  providerId: string;
  name: string;
  last4: string;
  updatedAt: string;
}

interface KodaKey {
  providerId: string;
  name: string;
  last4: string;
  updatedAt: string;
}

interface BoardAnswer {
  generatedAt: string;
  warnDays: number;
  kodaKeys: KodaKey[];
  runners: Array<{ id: string; readable: boolean; providerVault: boolean }>;
  providers: Array<{ providerId: string; cells: Record<string, unknown> }>;
  profiles: Array<{ name: string }>;
}

/** The vault's own ready capabilities (US-010 reports the helper), so the board can see a "vault on" runner. */
const VAULT_CAPS: RunnerCapabilities = { ...FLEET_CAPS, providerVault: true };

const body = (over: Record<string, unknown> = {}) => ({ providerId: 'openrouter', name: 'fleet', key: 'sk-or-abcdef123456', ...over });

describeIntegration('credential board koda keys and runner vault state (PG)', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let previousKey: string | undefined;

  const server = () => app.getHttpServer();
  const root = () => ({ Authorization: `Bearer ${world.tokens.root}` });
  const createGlobal = (payload: Record<string, unknown>) =>
    request(server()).post(GLOBAL_KEYS).set(root()).send(payload).expect(201);
  const createProject = (payload: Record<string, unknown>) =>
    request(server()).post(PROJECT_KEYS).set(root()).send(payload).expect(201);
  const board = async (): Promise<BoardAnswer> => data<BoardAnswer>(await request(server()).get(BOARD).set(root()).expect(200));

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
    await db.fleetActivity.deleteMany();
    await db.auditEntry.deleteMany();
    await db.runner.deleteMany();
  });

  it('AC-5: lists each active GLOBAL key as { providerId, name, last4, updatedAt } with no key field', async () => {
    const openrouter = data<CredentialRow>(await createGlobal(body()));
    const openai = data<CredentialRow>(await createGlobal(body({ providerId: 'openai', name: 'review', key: 'sk-oa-xxxxxxxx9876' })));

    const answer = await board();

    expect(answer.kodaKeys).toEqual([
      { providerId: 'openai', name: 'review', last4: '9876', updatedAt: openai.updatedAt },
      { providerId: 'openrouter', name: 'fleet', last4: '3456', updatedAt: openrouter.updatedAt },
    ]);
    for (const key of answer.kodaKeys) {
      expect(Object.keys(key).sort()).toEqual(['last4', 'name', 'providerId', 'updatedAt']);
    }
  });

  it('AC-5: the board answer carries neither the key nor its ciphertext', async () => {
    await createGlobal(body());

    const response = await request(server()).get(BOARD).set(root()).expect(200);

    expect(response.body.data.kodaKeys).toHaveLength(1);
    expect(JSON.stringify(response.body)).not.toContain('sk-or-abcdef123456');
    expect(JSON.stringify(response.body)).not.toContain('encryptedKey');
  });

  it('AC-6: omits a disabled GLOBAL key from kodaKeys', async () => {
    const disabled = data<CredentialRow>(await createGlobal(body()));
    await createGlobal(body({ providerId: 'openai', name: 'review', key: 'sk-oa-xxxxxxxx9876' }));
    await request(server()).patch(`${GLOBAL_KEYS}/${disabled.id}`).set(root()).send({ disabled: true }).expect(200);

    const answer = await board();

    // Both rows are still there: the disabled one is filtered by the read, not missing from the table.
    expect(await db.providerCredential.count()).toBe(2);
    expect(answer.kodaKeys.map((key) => key.providerId)).toEqual(['openai']);
  });

  it('AC-7: omits PROJECT and REPO keys from kodaKeys', async () => {
    await createGlobal(body({ name: 'global' }));
    await createProject(body({ name: 'project', key: 'sk-or-project123456' }));
    await createProject(body({ providerId: 'deepseek', name: 'repo', key: 'sk-ds-repo1234567', repoId: world.repoId }));

    const answer = await board();

    expect(await db.providerCredential.count()).toBe(3);
    expect(answer.kodaKeys.map((key) => key.name)).toEqual(['global']);
    expect(answer.kodaKeys.map((key) => key.providerId)).toEqual(['openrouter']);
    expect(JSON.stringify(answer.kodaKeys)).not.toContain('sk-or-project123456');
  });

  it('adds a provider that only a koda key represents to the provider inventory', async () => {
    // No runner reports `mistral`; the koda column still needs its row to render the vault's key.
    const runner = await enrollRunner(server(), world.tokens.root, 'board-runner', { capabilities: VAULT_CAPS });
    await createGlobal(body({ providerId: 'mistral', name: 'fleet', key: 'sk-ms-abcdef123456' }));

    const answer = await board();

    // The runner still reports its own `deepseek` provider; `mistral` comes from the koda key alone.
    expect(answer.providers.map((provider) => provider.providerId)).toEqual(['deepseek', 'mistral']);
    // The koda column is `kodaKeys`, not a cell: the runner grid still says "missing".
    expect(answer.providers.find((provider) => provider.providerId === 'mistral')?.cells)
      .toEqual({ [runner.runnerId]: { state: 'missing', kind: 'none' } });
  });

  it('reports each runner providerVault capability, and false for a runner that reports none', async () => {
    const vault = await enrollRunner(server(), world.tokens.root, 'vault-runner', { capabilities: VAULT_CAPS });
    const plain = await enrollRunner(server(), world.tokens.root, 'plain-runner', { capabilities: FLEET_CAPS, bootId: 'boot-2' });

    const answer = await board();

    // Ordered by runner name on the server, so the assertion reads each runner by id.
    const vaultState = (runnerId: string) => answer.runners.find((runner) => runner.id === runnerId);
    expect(vaultState(vault.runnerId)).toMatchObject({ readable: true, providerVault: true });
    expect(vaultState(plain.runnerId)).toMatchObject({ readable: true, providerVault: false });
  });

  /**
   * AC-5 at the edge of a page: creation accepts any valid provider id and storage bounds nothing, so
   * a board that read one page would list 200 of these 201 keys and quietly hide the last one — the
   * provider row that names it included.
   */
  it('AC-5: lists every active GLOBAL key of an inventory past one read page', async () => {
    const total = PROVIDER_KEY_SUMMARY_PAGE_SIZE + 1;
    const providerId = (i: number) => `provider-${String(i).padStart(3, '0')}`;
    const owner = world.ids.root;
    await db.providerCredential.createMany({
      data: Array.from({ length: total }, (_, i) => ({
        scope: 'GLOBAL', scopeKey: 'global', projectId: null, repoId: null,
        providerId: providerId(i), name: `key-${i}`, encryptedKey: '00:00:00', last4: String(1000 + i),
        fingerprint: `${String(i).padStart(12, '0')}`, createdById: owner, updatedById: owner,
      })),
    });

    const answer = await board();

    expect(answer.kodaKeys).toHaveLength(total);
    expect(answer.kodaKeys.map((key) => key.providerId)).toEqual(Array.from({ length: total }, (_, i) => providerId(i)));
    // Every key is represented in the provider inventory too, so the column can render each row.
    expect(answer.providers.map((provider) => provider.providerId)).toEqual(
      Array.from({ length: total }, (_, i) => providerId(i)),
    );
    expect(answer.kodaKeys.at(-1)).toMatchObject({ providerId: providerId(total - 1), last4: String(1000 + total - 1) });
  });
});

/**
 * AC-8 needs a boot whose config has no master key, which is a second application in this file. It is
 * self-contained — its own reset, its own owner and its own GLOBAL row — so it passes alone against a
 * fresh database and does not depend on the other suite having seeded anything.
 */
describeIntegration('credential board with the vault off (PG)', () => {
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
      // The first registered user is the installation owner, so it holds `fleet.credential.read`.
      token = data<{ accessToken: string }>(
        await request(server()).post('/api/auth/register')
          .send({ email: 'vault-off@koda.test', name: 'Vault Off', password: TEST_PASSWORD }).expect(201),
      ).accessToken;
      const owner = await db.user.findUniqueOrThrow({ where: { email: 'vault-off@koda.test' } });
      // A real GLOBAL row, sealed under a master key this boot does not have: the vault being off is
      // what must hide it, not the absence of rows.
      await db.providerCredential.create({
        data: {
          scope: 'GLOBAL', scopeKey: 'global', projectId: null, repoId: null,
          providerId: 'openrouter', name: 'fleet', encryptedKey: '00:00:00', last4: '3456',
          fingerprint: '0123456789ab', createdById: owner.id, updatedById: owner.id,
        },
      });
    } finally {
      if (previousKey === undefined) delete process.env[ENCRYPTION_KEY_ENV];
      else process.env[ENCRYPTION_KEY_ENV] = previousKey;
    }
  }, 90_000);

  afterAll(async () => { await app?.close(); });

  it('AC-8: answers kodaKeys: [] while the vault is off, keeping the existing board shape', async () => {
    const answer = data<BoardAnswer>(await request(server()).get(BOARD).set({ Authorization: `Bearer ${token}` }).expect(200));

    expect(answer.kodaKeys).toEqual([]);
    expect(Object.keys(answer).sort()).toEqual(['generatedAt', 'kodaKeys', 'profiles', 'providers', 'runners', 'warnDays']);
    // The stored key still names a provider, but a board with the vault off has no koda column at all.
    expect(answer.providers).toEqual([]);
    expect(await db.providerCredential.count()).toBe(1);
  });
});
