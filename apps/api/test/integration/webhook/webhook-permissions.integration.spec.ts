/**
 * US-005 — outbound webhook route keys with real RoleBinding evaluation over HTTP + Postgres.
 * Each non-global principal has only one project RoleBinding in p1 (no ProjectMember row).
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { MembershipService } from '../../../src/permissions/membership.service';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const P1_SLUG = 'p1';
const P2_SLUG = 'p2';
const WEBHOOK_URL = 'https://93.184.215.14/hook';
const BOOT_TIMEOUT = 60_000;
const TIMEOUT = 30_000;

interface WebhookDto {
  id: string;
  active: boolean;
  url: string;
  secret?: string;
}

describeIntegration('webhook route permission keys (US-005)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let membership: MembershipService;
  const userIds: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  const projectIds: Record<string, string> = {};

  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const asRoot = (method: 'get' | 'post' | 'patch' | 'delete', url: string, payload?: object) => {
    const req = request(server)[method](url).set(auth('root'));
    return payload === undefined ? req : req.send(payload);
  };

  const createWebhook = async (slug = P1_SLUG, url = WEBHOOK_URL): Promise<string> => {
    const row = await db.webhook.create({
      data: {
        projectId: projectIds[slug] ?? '',
        url,
        secret: 'integration-secret',
        events: JSON.stringify(['STATUS_CHANGE']),
      },
      select: { id: true },
    });
    return row.id;
  };

  const bind = async (who: string, roleKey: 'project-admin' | 'developer' | 'viewer'): Promise<void> => {
    const role = await db.role.findUniqueOrThrow({ where: { key: roleKey }, select: { id: true } });
    await db.roleBinding.create({
      data: {
        principalType: 'USER',
        principalId: userIds[who] ?? '',
        roleId: role.id,
        projectId: projectIds[P1_SLUG],
        grantedByType: 'SYSTEM',
        grantedById: 'US-005-test',
      },
    });
  };

  const expectPermissionsRefusal = (res: request.Response): void => {
    expect(res.status).toBe(403);
    expect(res.body.ret).toBe(40003);
    expect(res.body.message).toBe('You do not have permissions to perform this action');
  };

  /**
   * Permissions P1l (US-005): the create route takes no role, so `'ADMIN'` means "create a plain
   * member, then bind the global `admin` role" — binding before the login, because the grant
   * promotes `User.role` and revokes older tokens.
   */
  const createUser = async (who: string, admin = false): Promise<void> => {
    const created = await asRoot('post', '/api/admin/users', {
      email: `${who}@webhook-permissions.test`,
      name: who,
      password: TEST_PASSWORD,
    }).expect(201);
    userIds[who] = data<{ id: string }>(created).id;
    if (admin) await grantRole(db, { type: 'USER', id: userIds[who] as string }, 'admin');
    resetThrottle(app);
    tokens[who] = await loginToken(server, `${who}@webhook-permissions.test`);
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    server = app.getHttpServer();
    db = app.get<PrismaService<PrismaClient>>(PrismaService).client as PrismaClient;
    membership = app.get(MembershipService);

    const rootRes = await request(server)
      .post('/api/auth/register')
      .send({ email: 'root@webhook-permissions.test', name: 'Root', password: TEST_PASSWORD })
      .expect(201);
    tokens.root = data<{ accessToken: string }>(rootRes).accessToken;
    for (const who of ['padmin', 'developer', 'viewer', 'outsider']) await createUser(who);
    await createUser('global-admin', true);

    for (const [slug, name, key] of [[P1_SLUG, 'P1', 'PONE'], [P2_SLUG, 'P2', 'PTWO']] as const) {
      const res = await asRoot('post', '/api/projects', { name, slug, key }).expect(201);
      projectIds[slug] = data<{ id: string }>(res).id;
    }

    await bind('padmin', 'project-admin');
    await bind('developer', 'developer');
    await bind('viewer', 'viewer');
    // Populate permission cache only after all binding rows are present.
    await membership.invalidatePermissions();

  }, BOOT_TIMEOUT);

  afterAll(async () => {
    await app?.close();
  });

  it('AC-1: project-admin binding alone creates a webhook', async () => {
    const res = await request(server)
      .post(`/api/projects/${P1_SLUG}/webhooks`)
      .set(auth('padmin'))
      .send({ url: WEBHOOK_URL, events: ['STATUS_CHANGE'] })
      .expect(201);

    const created = data<WebhookDto>(res);
    expect(created.url).toBe(WEBHOOK_URL);
    await expect(db.webhook.findUnique({ where: { id: created.id }, select: { projectId: true } }))
      .resolves.toEqual({ projectId: projectIds[P1_SLUG] });
  }, TIMEOUT);

  it('AC-2: developer binding is refused from create and writes no webhook', async () => {
    const before = await db.webhook.count({ where: { projectId: projectIds[P1_SLUG] } });
    const res = await request(server)
      .post(`/api/projects/${P1_SLUG}/webhooks`)
      .set(auth('developer'))
      .send({ url: WEBHOOK_URL, events: ['STATUS_CHANGE'] });

    expectPermissionsRefusal(res);
    await expect(db.webhook.count({ where: { projectId: projectIds[P1_SLUG] } })).resolves.toBe(before);
  }, TIMEOUT);

  it('AC-3: viewer binding lists webhooks without exposing secrets', async () => {
    const id = await createWebhook();
    const res = await request(server).get(`/api/projects/${P1_SLUG}/webhooks`).set(auth('viewer')).expect(200);

    const items = data<WebhookDto[]>(res);
    const item = items.find((entry) => entry.id === id);
    expect(item).toBeDefined();
    expect(item).not.toHaveProperty('secret');
  }, TIMEOUT);

  it('AC-4: viewer binding cannot deactivate a webhook', async () => {
    const id = await createWebhook();
    const res = await request(server)
      .patch(`/api/projects/${P1_SLUG}/webhooks/${id}`)
      .set(auth('viewer'))
      .send({ active: false });

    expectPermissionsRefusal(res);
    await expect(db.webhook.findUniqueOrThrow({ where: { id }, select: { active: true } }))
      .resolves.toEqual({ active: true });
  }, TIMEOUT);

  it('AC-5: project-admin binding deactivates a webhook', async () => {
    const id = await createWebhook();
    await request(server)
      .patch(`/api/projects/${P1_SLUG}/webhooks/${id}`)
      .set(auth('padmin'))
      .send({ active: false })
      .expect(200);

    await expect(db.webhook.findUniqueOrThrow({ where: { id }, select: { active: true } }))
      .resolves.toEqual({ active: false });
  }, TIMEOUT);

  it('AC-6: project-admin binding deletes a project webhook', async () => {
    const id = await createWebhook();
    await request(server).delete(`/api/projects/${P1_SLUG}/webhooks/${id}`).set(auth('padmin')).expect(204);

    await expect(db.webhook.findUnique({ where: { id } })).resolves.toBeNull();
  }, TIMEOUT);

  it('AC-7: developer binding cannot delete a project webhook', async () => {
    const id = await createWebhook();
    const res = await request(server).delete(`/api/projects/${P1_SLUG}/webhooks/${id}`).set(auth('developer'));

    expectPermissionsRefusal(res);
    await expect(db.webhook.findUnique({ where: { id } })).resolves.not.toBeNull();
  }, TIMEOUT);

  it('AC-8: project-admin binding cannot use the global delete route', async () => {
    const id = await createWebhook();
    const res = await request(server).delete(`/api/webhooks/${id}`).set(auth('padmin'));

    expectPermissionsRefusal(res);
    await expect(db.webhook.findUnique({ where: { id } })).resolves.not.toBeNull();
  }, TIMEOUT);

  it('AC-9: a global admin deletes a webhook through the global route', async () => {
    const id = await createWebhook();
    await request(server).delete(`/api/webhooks/${id}`).set(auth('global-admin')).expect(204);

    await expect(db.webhook.findUnique({ where: { id } })).resolves.toBeNull();
  }, TIMEOUT);

  it('AC-10: a user without project access gets a projects refusal before key evaluation', async () => {
    const res = await request(server).get(`/api/projects/${P1_SLUG}/webhooks`).set(auth('outsider'));

    expect(res.status).toBe(403);
    expect(res.body.ret).toBe(40003);
    expect(res.body.message).toBe('projects.40003');
  }, TIMEOUT);

  it('AC-11: project-admin binding gets 404 for a webhook belonging to another project', async () => {
    const id = await createWebhook(P2_SLUG, 'https://93.184.215.15/hook');
    const before = await db.webhook.findUniqueOrThrow({ where: { id }, select: { active: true, url: true } });
    const res = await request(server)
      .patch(`/api/projects/${P1_SLUG}/webhooks/${id}`)
      .set(auth('padmin'))
      .send({ active: false });

    expect(res.status).toBe(404);
    expect(await db.webhook.findUniqueOrThrow({ where: { id }, select: { active: true, url: true } })).toEqual(before);
  }, TIMEOUT);
});
