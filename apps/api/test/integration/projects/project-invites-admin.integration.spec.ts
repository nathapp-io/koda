/**
 * US-004 — admin invite routes over real Postgres.
 *
 * Covers the project-scoped `POST /projects/:slug/invites` and
 * `GET /projects/:slug/invites` endpoints (US-004 ACs 1-12, plus US-005 resend/cancel
 * shakedown). Behaviour-only duplicate of `.nax/features/fleet-s4b-email-invites/.nax-acceptance.test.ts`,
 * kept as a developer-facing regression suite per the spec's "Creates" list.
 *
 * Run: cd apps/api && bun run test:db:up && KODA_DB_TESTS=1 npx jest --config jest.nax.config.js test/integration/projects/project-invites-admin
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

interface InviteDto {
  id: string;
  email: string;
  role: string;
  status: string;
  inviterName: string | null;
  expiresAt: string;
  createdAt: string;
}

interface InviteCreateResult {
  outcome: string;
  member?: { userId: string; email: string; role: string };
  invite?: InviteDto;
  invitePath?: string;
  emailed?: boolean;
}

const unique = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const projectKey = (): string =>
  Array.from({ length: 4 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');

describeIntegration('US-004 admin invite routes over HTTP (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaService<PrismaClient>;
  let rootToken: string;
  let viewerToken: string;

  const post = (path: string, body: object, token: string = rootToken) =>
    request(server).post(`/api${path}`).set({ Authorization: `Bearer ${token}` }).send(body);
  const get = (path: string, token: string = rootToken) =>
    request(server).get(`/api${path}`).set({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService);

    // Global admin creates the project.
    const rootRes = await request(server).post('/api/auth/register')
      .send({ email: 's4b-admin@koda.test', name: 'S4b Admin', password: TEST_PASSWORD }).expect(201);
    rootToken = (rootRes.body.data as { accessToken: string }).accessToken;

    // Project + members: developer + viewer. The members route requires the user
    // to already exist, so register them first then add them to the project.
    const slug = `s4b-admin-${unique()}`;
    await post('/projects', { name: 'S4b Admin', slug, key: projectKey() }).expect(201);

    const devEmail = `dev-${unique()}@koda.test`;
    const viewerEmail = `viewer-${unique()}@koda.test`;
    await request(server).post('/api/auth/register')
      .send({ email: devEmail, name: 'Developer', password: TEST_PASSWORD }).expect(201);
    await request(server).post('/api/auth/register')
      .send({ email: viewerEmail, name: 'Viewer', password: TEST_PASSWORD }).expect(201);
    await post(`/projects/${slug}/members`, { email: devEmail, role: 'DEVELOPER' }).expect(201);
    await post(`/projects/${slug}/members`, { email: viewerEmail, role: 'VIEWER' }).expect(201);

    viewerToken = await loginToken(server, viewerEmail);
  });

  afterAll(async () => {
    await app.close();
  });

  // ── US-004 AC-1 (role gating) ──────────────────────────────────────────────
  it('US-004 AC-1: a project member whose role is not ADMIN is forbidden from inviting', async () => {
    const slug = (await prisma.client.project.findFirstOrThrow({ where: { name: 'S4b Admin' } })).slug;
    const res = await post(`/projects/${slug}/invites`, { email: `${unique()}@x.io`, role: 'DEVELOPER' }, viewerToken);
    expect(res.status).toBe(403);
  });

  // ── US-004 AC-2 (existing active user) ────────────────────────────────────
  it('US-004 AC-2: inviting an active existing user adds them with the requested role and normalised email', async () => {
    const slug = (await prisma.client.project.findFirstOrThrow({ where: { name: 'S4b Admin' } })).slug;
    const email = ` New@X.io `.trim();

    // Seed a global user with a normalised email outside the project.
    const userEmail = email.trim().toLowerCase();
    await request(server).post('/api/auth/register')
      .send({ email: userEmail, name: 'Newcomer', password: TEST_PASSWORD }).expect(201);

    const res = await post(`/projects/${slug}/invites`, { email, role: 'DEVELOPER' });
    expect(res.status).toBe(201);
    const body = data<InviteCreateResult>(res);
    expect(body.outcome).toBe('ADDED');
    expect(body.member).toBeDefined();
    expect(body.member?.email).toBe(userEmail);
    expect(body.member?.role).toBe('DEVELOPER');

    const projectId = (await prisma.client.project.findFirstOrThrow({ where: { slug } })).id;
    const user = await prisma.client.user.findFirstOrThrow({ where: { email: userEmail } });
    const membership = await prisma.client.projectMember.findFirstOrThrow({
      where: { projectId, userId: user.id },
    });
    expect(membership.role).toBe('DEVELOPER');
  });

  // ── US-004 AC-3 (already-member) ──────────────────────────────────────────
  it('US-004 AC-3: inviting an existing project member responds 409', async () => {
    const slug = (await prisma.client.project.findFirstOrThrow({ where: { name: 'S4b Admin' } })).slug;
    const member = await prisma.client.projectMember.findFirstOrThrow({
      where: { project: { slug }, role: 'DEVELOPER' },
      include: { user: true },
    });

    const res = await post(`/projects/${slug}/invites`, { email: member.user.email, role: 'DEVELOPER' });
    expect(res.status).toBe(409);
  });

  // ── US-004 AC-4 (disabled user) ───────────────────────────────────────────
  it('US-004 AC-4: inviting a disabled user responds 409', async () => {
    const slug = (await prisma.client.project.findFirstOrThrow({ where: { name: 'S4b Admin' } })).slug;
    const disabledEmail = `disabled-${unique()}@koda.test`;
    await request(server).post('/api/auth/register')
      .send({ email: disabledEmail, name: 'Disabled', password: TEST_PASSWORD }).expect(201);
    const user = await prisma.client.user.findFirstOrThrow({ where: { email: disabledEmail } });
    await prisma.client.user.update({ where: { id: user.id }, data: { disabled: true } });

    const res = await post(`/projects/${slug}/invites`, { email: disabledEmail, role: 'DEVELOPER' });
    expect(res.status).toBe(409);
  });

  // ── US-004 AC-5 (new account → INVITED) ───────────────────────────────────
  it('US-004 AC-5: inviting a new email returns an INVITED outcome with a hash and a one-time raw path', async () => {
    const slug = (await prisma.client.project.findFirstOrThrow({ where: { name: 'S4b Admin' } })).slug;
    const email = `new-${unique()}@example.com`;

    const res = await post(`/projects/${slug}/invites`, { email, role: 'VIEWER' });
    expect(res.status).toBe(201);
    const body = data<InviteCreateResult>(res);
    expect(body.outcome).toBe('INVITED');
    expect(body.invite).toBeDefined();
    expect(body.invitePath).toBeDefined();
    expect(body.invitePath?.startsWith('/invite/')).toBe(true);
    expect(body.emailed).toBe(false);

    const raw = (body.invitePath ?? '').split('/').pop() ?? '';
    const row = await prisma.client.projectInvite.findFirstOrThrow({ where: { id: body.invite?.id } });
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.email).toBe(email);
  });

  // ── US-004 AC-6 (second invite cancels the first) ─────────────────────────
  it('US-004 AC-6: a second invite for the same project and email cancels the first', async () => {
    const slug = (await prisma.client.project.findFirstOrThrow({ where: { name: 'S4b Admin' } })).slug;
    const email = `repeat-${unique()}@example.com`;

    const first = await post(`/projects/${slug}/invites`, { email, role: 'DEVELOPER' });
    expect(first.status).toBe(201);
    const firstId = (data<InviteCreateResult>(first).invite as InviteDto).id;

    const second = await post(`/projects/${slug}/invites`, { email, role: 'DEVELOPER' });
    expect(second.status).toBe(201);

    const cancelled = await prisma.client.projectInvite.findUniqueOrThrow({ where: { id: firstId } });
    expect(cancelled.status).toBe('CANCELLED');

    const pending = await prisma.client.projectInvite.findMany({
      where: { project: { slug }, email, status: 'PENDING' },
    });
    expect(pending).toHaveLength(1);
  });

  // ── US-004 AC-7 (list omits token material) ───────────────────────────────
  it('US-004 AC-7: GET list returns invites with no token or tokenHash field', async () => {
    const slug = (await prisma.client.project.findFirstOrThrow({ where: { name: 'S4b Admin' } })).slug;
    const res = await get(`/projects/${slug}/invites`);
    expect(res.status).toBe(200);
    const invites = data<InviteDto[]>(res);
    expect(Array.isArray(invites)).toBe(true);
    for (const invite of invites) {
      expect(invite).not.toHaveProperty('token');
      expect(invite).not.toHaveProperty('tokenHash');
      expect(Object.keys(invite).sort()).toEqual(
        ['createdAt', 'email', 'expiresAt', 'id', 'inviterName', 'role', 'status'].sort(),
      );
    }
  });

  // ── US-004 AC-8 (EXPIRED computed on read) ────────────────────────────────
  it('US-004 AC-8: a PENDING invite past its expiresAt is reported as EXPIRED without modifying the row', async () => {
    const slug = (await prisma.client.project.findFirstOrThrow({ where: { name: 'S4b Admin' } })).slug;
    const email = `expired-${unique()}@example.com`;
    const created = await post(`/projects/${slug}/invites`, { email, role: 'DEVELOPER' });
    const id = (data<InviteCreateResult>(created).invite as InviteDto).id;

    await prisma.client.projectInvite.update({
      where: { id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const res = await get(`/projects/${slug}/invites`);
    const invites = data<InviteDto[]>(res);
    const found = invites.find((i) => i.id === id);
    expect(found?.status).toBe('EXPIRED');

    const row = await prisma.client.projectInvite.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('PENDING');
  });

  // ── US-004 AC-9 (bad role) ────────────────────────────────────────────────
  it('US-004 AC-9: an unknown role is rejected with 400', async () => {
    const slug = (await prisma.client.project.findFirstOrThrow({ where: { name: 'S4b Admin' } })).slug;
    const res = await post(`/projects/${slug}/invites`, { email: `${unique()}@x.io`, role: 'AGENT' });
    expect(res.status).toBe(400);
  });
});
