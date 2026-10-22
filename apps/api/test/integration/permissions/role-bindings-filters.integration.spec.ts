/**
 * Permissions P1 US-002 — the `GET /role-bindings` filters, over real HTTP + Postgres (AC-6 .. AC-10).
 *
 * The binding browser needs two reads the route could not answer before: "every agent's global
 * bindings" in one request (`principalType` alone) and "this principal's global bindings"
 * (`scope=global`). A half-specified principal stays refused, and asking for the global scope and one
 * project at once is a validation refusal with its own key rather than a silently empty page.
 *
 * One booted application for the whole file; the first registration is the installation's Owner, so
 * every fixture below is written as that Owner and the listings are read through its `role.read`.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/permissions/role-bindings-filters.integration.spec.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const OWNER_EMAIL = 'owner@koda.test';
const MEMBER_EMAIL = 'plain@koda.test';
const SCOPED_EMAIL = 'scoped@koda.test';
/** Booting `AppModule` runs the system-role seeder, so the first hook needs a generous budget. */
const BOOT_TIMEOUT_MS = 30_000;

/** `permissions.json` as the i18n loader reads it: the expected sentence of every refusal. */
const TRANSLATIONS = JSON.parse(
  readFileSync(join(__dirname, '../../../src/i18n/en/permissions.json'), 'utf8'),
) as Record<string, unknown>;

interface BindingBody {
  id: string;
  principalType: string;
  principalId: string;
  roleKey: string;
  projectId: string | null;
}

interface PageBody {
  total: number;
  records: BindingBody[];
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

describeIntegration('role binding list filters (US-002)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let ownerToken: string;
  let projectId: string;
  let agentAId: string;
  let agentBId: string;
  let plainUserId: string;
  let scopedUserId: string;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const bindings = (query: Record<string, string>) =>
    request(server).get('/api/role-bindings').query(query).set(auth(ownerToken));

  /** Creates a user through the admin route: the baseline `member` binding comes from production code. */
  const createUser = async (email: string, role: 'MEMBER' | 'ADMIN'): Promise<string> => {
    const created = await request(server)
      .post('/api/admin/users')
      .set(auth(ownerToken))
      .send({ email, name: email.split('@')[0], password: TEST_PASSWORD, role })
      .expect(201);
    resetThrottle(app);
    return data<{ id: string }>(created).id;
  };

  const createAgent = async (slug: string): Promise<string> => {
    const created = await request(server)
      .post('/api/agents')
      .set(auth(ownerToken))
      .send({ name: slug, slug })
      .expect(201);
    return data<{ agent: { id: string } }>(created).agent.id;
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    server = app.getHttpServer();
    db = app.get<PrismaService<PrismaClient>>(PrismaService).client as PrismaClient;

    const registered = await request(server)
      .post('/api/auth/register')
      .send({ email: OWNER_EMAIL, name: 'Owner', password: TEST_PASSWORD })
      .expect(201);
    ownerToken = data<{ accessToken: string }>(registered).accessToken;

    const project = await request(server)
      .post('/api/projects')
      .set(auth(ownerToken))
      .send({ name: 'Project P', slug: 'p', key: 'PONE' })
      .expect(201);
    projectId = data<{ id: string }>(project).id;

    // AC-6's three principals: two agents and one user, each with a global binding.
    agentAId = await createAgent('filter-agent-a');
    agentBId = await createAgent('filter-agent-b');
    plainUserId = await createUser(MEMBER_EMAIL, 'MEMBER');

    // AC-7's principal: one global `admin` binding and one `developer` binding in p. The member
    // baseline production writes on create is removed so "one global binding" is literal.
    scopedUserId = await createUser(SCOPED_EMAIL, 'MEMBER');
    await grantRole(db, { type: 'USER', id: scopedUserId }, 'admin');
    await grantRole(db, { type: 'USER', id: scopedUserId }, 'developer', projectId);
    await db.roleBinding.deleteMany({
      where: { principalType: 'USER', principalId: scopedUserId, role: { key: 'member' } },
    });
    resetThrottle(app);
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await app?.close();
  });

  it('AC-6: principalType=AGENT alone lists the two agents\' global bindings and no user binding', async () => {
    // The premise: exactly the two agents hold an AGENT binding, and the user's global binding exists.
    expect(await db.roleBinding.count({ where: { principalType: 'AGENT' } })).toBe(2);
    expect(
      await db.roleBinding.count({ where: { principalType: 'USER', principalId: plainUserId } }),
    ).toBe(1);

    const res = await bindings({ principalType: 'AGENT' });

    expect(res.status).toBe(200);
    const page = data<PageBody>(res);
    expect(page.total).toBe(2);
    expect(page.records.map((binding) => binding.principalId).sort()).toEqual(
      [agentAId, agentBId].sort(),
    );
    expect(page.records.every((binding) => binding.principalType === 'AGENT')).toBe(true);
    expect(page.records.map((binding) => binding.principalId)).not.toContain(plainUserId);
  });

  it('AC-7: principalType=USER with principalId and scope=global lists only the global binding', async () => {
    // The premise: one global `admin` binding and one `developer` binding in p.
    expect(
      await db.roleBinding.count({
        where: { principalType: 'USER', principalId: scopedUserId, projectId: null },
      }),
    ).toBe(1);
    expect(
      await db.roleBinding.count({
        where: { principalType: 'USER', principalId: scopedUserId, projectId },
      }),
    ).toBe(1);

    const res = await bindings({ principalType: 'USER', principalId: scopedUserId, scope: 'global' });

    expect(res.status).toBe(200);
    const page = data<PageBody>(res);
    expect(page.total).toBe(1);
    expect(page.records).toHaveLength(1);
    expect(page.records[0]).toEqual(
      expect.objectContaining({
        principalType: 'USER',
        principalId: scopedUserId,
        roleKey: 'admin',
        projectId: null,
      }),
    );
  });

  it('AC-8: a lone principalId without principalType is a validation refusal', async () => {
    const res = await bindings({ principalId: scopedUserId });

    expect(res.status).toBe(400);
    expect(res.body.ret).toBe(-2);
    expect(res.body).not.toHaveProperty('data');
  });

  it('AC-9: scope=project is a validation refusal', async () => {
    const res = await bindings({ scope: 'project' });

    expect(res.status).toBe(400);
    expect(res.body.ret).toBe(-2);
    expect(res.body).not.toHaveProperty('data');
  });

  it('AC-10: scope=global with a projectId answers 400 permissions.scopeAndProject', async () => {
    const res = await bindings({ scope: 'global', projectId });

    expect(res.status).toBe(400);
    expect(res.body.ret).toBe(-2);
    expect(res.body.message).toBe(sentence('scopeAndProject', -2));
    expect(res.body).not.toHaveProperty('data');
  });
});
