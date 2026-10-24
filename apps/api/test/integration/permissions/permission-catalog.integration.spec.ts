/**
 * Permissions P1 US-002 — the permission catalog and the role keys it lets a client expand, over
 * real HTTP + Postgres (AC-1 .. AC-4).
 *
 * `GET /permissions/catalog` is the metadata half of the role editor: risk, scope, principal types
 * and ownability per key, which until now lived in code only. `RoleDto.expandedKeys` is the other
 * half: what a role's stored entries stand for. Both are read-only, and both are gated on
 * `role.read`, so a baseline member can read neither.
 *
 * One booted application for the whole file; the first registration is the installation's Owner, and
 * the member is created through `POST /admin/users`, so every 200/403 below is decided by real
 * bindings.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/permissions/permission-catalog.integration.spec.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { PERMISSION_CATALOG } from '../../../src/permissions/catalog';
import { expandEntries } from '../../../src/permissions/entry-matcher';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { expectGuardActive, fixtureDb } from '../../helpers/action-context';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const OWNER_EMAIL = 'owner@koda.test';
const MEMBER_EMAIL = 'member@koda.test';
/** Booting `AppModule` runs the system-role seeder, so the first hook needs a generous budget. */
const BOOT_TIMEOUT_MS = 30_000;

/** `permissions.json` as the i18n loader reads it: the expected sentence of every refusal. */
const TRANSLATIONS = JSON.parse(
  readFileSync(join(__dirname, '../../../src/i18n/en/permissions.json'), 'utf8'),
) as Record<string, unknown>;

interface CatalogEntryBody {
  key: string;
  scope: string;
  risk: string;
  principals: string[];
  ownable: boolean;
}

interface RoleBody {
  key: string;
  scope: string;
  permissions: string[];
  expandedKeys: string[];
}

/** The sentence at `permissions.<path>.<code>`, with its `{arg}` placeholders filled in. */
function sentence(path: string, code: number, args: Record<string, string> = {}): string {
  const key = path === '' ? `permissions.${code}` : `permissions.${path}.${code}`;
  const node = key.split('.').reduce<unknown>(
    (current, segment) =>
      typeof current === 'object' && current !== null
        ? (current as Record<string, unknown>)[segment]
        : undefined,
    { permissions: TRANSLATIONS },
  );
  if (typeof node !== 'string') throw new Error(`${key} is not declared in src/i18n/en/permissions.json`);
  return node.replace(/\{(\w+)\}/g, (placeholder, name: string) => args[name] ?? placeholder);
}

describeIntegration('permission catalog and expanded role keys (US-002)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let ownerToken: string;
  let memberToken: string;
  let memberId: string;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const catalog = (token: string) => request(server).get('/api/permissions/catalog').set(auth(token));
  const roles = (token: string) => request(server).get('/api/roles').set(auth(token));

  /** Creates a user through the admin route, then logs in: the token carries no bypass of its own. */
  /** Permissions P1l (US-005): the create route takes no role, so the account is a plain member. */
  const createUser = async (email: string): Promise<string> => {
    const created = await request(server)
      .post('/api/admin/users')
      .set(auth(ownerToken))
      .send({ email, name: email.split('@')[0], password: TEST_PASSWORD })
      .expect(201);
    expect(data<{ id: string }>(created).id).toBeTruthy();
    // Login is throttled to 5/min per instance; this hook performs more logins than that.
    resetThrottle(app);
    return loginToken(server, email);
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    server = app.getHttpServer();
    db = fixtureDb(app);

    const registered = await request(server)
      .post('/api/auth/register')
      .send({ email: OWNER_EMAIL, name: 'Owner', password: TEST_PASSWORD })
      .expect(201);
    ownerToken = data<{ accessToken: string }>(registered).accessToken;

    memberToken = await createUser(MEMBER_EMAIL);
    memberId = (await db.user.findUniqueOrThrow({ where: { email: MEMBER_EMAIL } })).id;
  }, BOOT_TIMEOUT_MS);

  beforeEach(() => {
    resetThrottle(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('AC-1: a global admin gets one entry per role-access catalog key, sorted by key', async () => {
    const res = await catalog(ownerToken);

    expect(res.status).toBe(200);
    const entries = data<CatalogEntryBody[]>(res);

    // Derived from the catalog itself: every role-grantable key, once, ascending. An implicit,
    // public, runner or system key in the answer would change this list.
    const expectedKeys = PERMISSION_CATALOG.filter((entry) => entry.access === 'role')
      .map((entry) => entry.key)
      .sort();
    expect(entries.map((entry) => entry.key)).toEqual(expectedKeys);
    expect(new Set(entries.map((entry) => entry.key)).size).toBe(entries.length);
  });

  it('AC-2: ticket.delete carries its catalog metadata and comment.update is ownable', async () => {
    const entries = data<CatalogEntryBody[]>(await catalog(ownerToken).expect(200));

    expect(entries.find((entry) => entry.key === 'ticket.delete')).toEqual({
      key: 'ticket.delete',
      scope: 'project',
      risk: 'high',
      principals: ['user', 'agent'],
      ownable: false,
    });
    expect(entries.find((entry) => entry.key === 'comment.update')).toEqual(
      expect.objectContaining({ ownable: true }),
    );
  });

  it('AC-3: a user whose only binding is the member baseline answers 403 permissions', async () => {
    // The premise: the baseline binding is the member's only grant, and `member` holds no `role.read`.
    expect(
      await db.roleBinding.count({ where: { principalType: 'USER', principalId: memberId } }),
    ).toBe(1);
    expect(
      await db.roleBinding.count({
        where: { principalType: 'USER', principalId: memberId, role: { key: 'member' } },
      }),
    ).toBe(1);

    const res = await catalog(memberToken);

    expect(res.status).toBe(403);
    expect(res.body.ret).toBe(40003);
    expect(res.body.message).toBe(sentence('', 40003));
    expect(res.body).not.toHaveProperty('data');
  });

  it('AC-4: developer.expandedKeys arrives ascending with ticket.create and comment.update.own, without ticket.delete', async () => {
    const res = await roles(ownerToken);

    expect(res.status).toBe(200);
    const developer = data<RoleBody[]>(res).find((role) => role.key === 'developer');
    expect(developer).toBeDefined();
    const body = developer as RoleBody;

    // Derived from the stored role, so the assertion follows the seed rather than a copy of it.
    const stored = await db.role.findUniqueOrThrow({ where: { key: 'developer' } });
    const entries = (stored.permissions as string[]).filter((entry) => typeof entry === 'string');
    expect(body.expandedKeys).toEqual([...expandEntries(entries, 'PROJECT')].sort());
    expect(body.expandedKeys).toEqual([...body.expandedKeys].sort());

    expect(body.expandedKeys).toContain('ticket.create');
    expect(body.expandedKeys).toContain('comment.update.own');
    expect(body.expandedKeys).not.toContain('ticket.delete');
  });
});
