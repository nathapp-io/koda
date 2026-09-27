/**
 * Track 3 Slice 3 (#144): project-role write permissions, replayed over real
 * HTTP + Postgres as project ADMIN, DEVELOPER and VIEWER (all global MEMBER).
 * Replaces #143's waived AC-29. Every case builds its own fixture, because
 * transitions and deletes consume their target.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:integration -- test/integration/projects/project-role-permissions
 * (Shared test DB: see the Slice 3 plan's warning before running.)
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { JwtStrategyProvider } from '@nathapp/nestjs-auth';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const TIMEOUT = 30_000;

type Role = 'ADMIN' | 'DEVELOPER' | 'VIEWER';
type Method = 'get' | 'post' | 'patch' | 'delete';
interface Case {
  capability: string;
  /** Builds a fresh target as root; returns the request to replay. */
  setup: () => Promise<{ method: Method; url: string; body?: Record<string, unknown>; as?: (role: Role) => string }>;
  allowed: Record<Role, boolean>;
}

describeIntegration('project-role permissions (#144)', () => {
  let app: NathApplication;
  let server: Parameters<typeof request>[0];
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let counter = 0;

  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const asRoot = (method: Method, url: string, body?: Record<string, unknown>) => {
    const req = request(server)[method](url).set(auth('root'));
    return body === undefined ? req : req.send(body);
  };

  const createUser = async (who: string) => {
    const res = await asRoot('post', '/api/admin/users', { email: `${who}@koda.test`, name: who, password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
    ids[who] = data<{ id: string }>(res).id;
    tokens[who] = await loginToken(server, `${who}@koda.test`);
  };
  const addMember = (slug: string, who: string, role: Role) =>
    asRoot('post', `/api/projects/${slug}/members`, { email: `${who}@koda.test`, role }).expect(201);

  const ticketIn = async (status: 'CREATED' | 'VERIFIED' | 'IN_PROGRESS' | 'VERIFY_FIX', slug = 'team') => {
    const res = await asRoot('post', `/api/projects/${slug}/tickets`, { type: 'BUG', title: `t${counter++}` }).expect(201);
    const ref = data<{ ref: string }>(res).ref;
    const step = (action: string, body?: Record<string, unknown>) =>
      asRoot('post', `/api/projects/${slug}/tickets/${ref}/${action}`, body ?? {}).expect(200);
    if (status !== 'CREATED') await step('verify', { body: 'v' });
    if (status === 'IN_PROGRESS' || status === 'VERIFY_FIX') await step('start');
    if (status === 'VERIFY_FIX') await step('fix', { body: 'f' });
    return ref;
  };
  const label = async () => {
    const res = await asRoot('post', '/api/projects/team/labels', { name: `l${counter++}`, color: '#ff0000' }).expect(201);
    return data<{ id: string }>(res).id;
  };
  const commentBy = async (who: string, ref: string) => {
    const res = await request(server).post(`/api/projects/team/tickets/${ref}/comments`).set(auth(who)).send({ body: 'c' }).expect(201);
    return data<{ id: string }>(res).id;
  };

  const all = { ADMIN: true, DEVELOPER: true, VIEWER: true };
  const workers = { ADMIN: true, DEVELOPER: true, VIEWER: false };
  const adminOnly = { ADMIN: true, DEVELOPER: false, VIEWER: false };
  const whoFor: Record<Role, string> = { ADMIN: 'padmin', DEVELOPER: 'pdev', VIEWER: 'pviewer' };

  const cases: Case[] = [
    { capability: 'read ticket', allowed: all, setup: async () => ({ method: 'get', url: `/api/projects/team/tickets/${await ticketIn('CREATED')}` }) },
    { capability: 'read labels', allowed: all, setup: async () => ({ method: 'get', url: '/api/projects/team/labels' }) },
    { capability: 'read comments', allowed: all, setup: async () => ({ method: 'get', url: `/api/projects/team/tickets/${await ticketIn('CREATED')}/comments` }) },
    { capability: 'create ticket', allowed: workers, setup: async () => ({ method: 'post', url: '/api/projects/team/tickets', body: { type: 'BUG', title: 'by role' } }) },
    { capability: 'update ticket', allowed: workers, setup: async () => ({ method: 'patch', url: `/api/projects/team/tickets/${await ticketIn('CREATED')}`, body: { title: 'renamed' } }) },
    { capability: 'status via PATCH', allowed: workers, setup: async () => ({ method: 'patch', url: `/api/projects/team/tickets/${await ticketIn('VERIFIED')}`, body: { status: 'IN_PROGRESS' } }) },
    { capability: 'assign', allowed: workers, setup: async () => ({ method: 'post', url: `/api/projects/team/tickets/${await ticketIn('CREATED')}/assign`, body: { userId: ids.pdev } }) },
    { capability: 'verify', allowed: workers, setup: async () => ({ method: 'post', url: `/api/projects/team/tickets/${await ticketIn('CREATED')}/verify`, body: { body: 'ok' } }) },
    { capability: 'start', allowed: workers, setup: async () => ({ method: 'post', url: `/api/projects/team/tickets/${await ticketIn('VERIFIED')}/start` }) },
    { capability: 'fix', allowed: workers, setup: async () => ({ method: 'post', url: `/api/projects/team/tickets/${await ticketIn('IN_PROGRESS')}/fix`, body: { body: 'fixed' } }) },
    { capability: 'verify-fix approve', allowed: workers, setup: async () => ({ method: 'post', url: `/api/projects/team/tickets/${await ticketIn('VERIFY_FIX')}/verify-fix?approve=true`, body: { body: 'lgtm' } }) },
    { capability: 'reject', allowed: workers, setup: async () => ({ method: 'post', url: `/api/projects/team/tickets/${await ticketIn('CREATED')}/reject`, body: { body: 'no' } }) },
    { capability: 'close override', allowed: adminOnly, setup: async () => ({ method: 'post', url: `/api/projects/team/tickets/${await ticketIn('IN_PROGRESS')}/close`, body: { body: 'duplicate' } }) },
    { capability: 'delete ticket', allowed: adminOnly, setup: async () => ({ method: 'delete', url: `/api/projects/team/tickets/${await ticketIn('CREATED')}` }) },
    { capability: 'create label', allowed: workers, setup: async () => ({ method: 'post', url: '/api/projects/team/labels', body: { name: `r${counter++}`, color: '#00ff00' } }) },
    { capability: 'update label', allowed: adminOnly, setup: async () => ({ method: 'patch', url: `/api/projects/team/labels/${await label()}`, body: { name: `u${counter++}` } }) },
    { capability: 'delete label', allowed: adminOnly, setup: async () => ({ method: 'delete', url: `/api/projects/team/labels/${await label()}` }) },
    { capability: 'assign label to ticket', allowed: workers, setup: async () => ({ method: 'post', url: `/api/projects/team/tickets/${await ticketIn('CREATED')}/labels`, body: { labelId: await label() } }) },
    {
      capability: 'remove label from ticket', allowed: workers, setup: async () => {
        const ref = await ticketIn('CREATED');
        const labelId = await label();
        await asRoot('post', `/api/projects/team/tickets/${ref}/labels`, { labelId }).expect(201);
        return { method: 'delete', url: `/api/projects/team/tickets/${ref}/labels/${labelId}` };
      },
    },
    { capability: 'create comment', allowed: all, setup: async () => ({ method: 'post', url: `/api/projects/team/tickets/${await ticketIn('CREATED')}/comments`, body: { body: 'hello' } }) },
    {
      capability: 'update own comment', allowed: all, setup: async () => {
        const ref = await ticketIn('CREATED');
        return { method: 'patch', url: '', body: { body: 'edited' }, as: (role) => `/api/comments/__own__${role}::${ref}` };
      },
    },
    {
      capability: "delete another user's comment", allowed: adminOnly, setup: async () => {
        const ref = await ticketIn('CREATED');
        return { method: 'delete', url: '', as: (role) => `/api/comments/__other__${role}::${ref}` };
      },
    },
  ];

  /** Resolves the comment placeholders: own = authored by the caller; other = authored by a different member. */
  const resolveUrl = async (role: Role, spec: Awaited<ReturnType<Case['setup']>>) => {
    if (!spec.as) return spec.url;
    const [kind, ref] = spec.as(role).replace('/api/comments/', '').split('::');
    if (kind.startsWith('__own__')) return `/api/comments/${await commentBy(whoFor[role], ref)}`;
    const author = role === 'DEVELOPER' ? 'pviewer' : 'pdev';
    return `/api/comments/${await commentBy(author, ref)}`;
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    // registrationEnabled:false still allows the FIRST user (bootstrap admin), as in project-membership-gate.
    const root = await request(server).post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    tokens.root = data<{ accessToken: string }>(root).accessToken;

    for (const who of ['padmin', 'pdev', 'pviewer', 'multi']) await createUser(who);
    for (const [slug, key] of [['team', 'TEAM'], ['alpha', 'ALP']]) {
      await asRoot('post', '/api/projects', { name: slug, slug, key }).expect(201);
    }
    await addMember('team', 'padmin', 'ADMIN');
    await addMember('team', 'pdev', 'DEVELOPER');
    await addMember('team', 'pviewer', 'VIEWER');
    await addMember('alpha', 'multi', 'ADMIN');
    await addMember('team', 'multi', 'VIEWER');
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  for (const c of cases) {
    for (const role of ['ADMIN', 'DEVELOPER', 'VIEWER'] as const) {
      const expected = c.allowed[role];
      it(`${c.capability}: project ${role} -> ${expected ? 'allowed' : '403'}`, async () => {
        const spec = await c.setup();
        const url = await resolveUrl(role, spec);
        const req = request(server)[spec.method](url).set(auth(whoFor[role]));
        const res = await (spec.body === undefined ? req : req.send(spec.body));
        if (expected) {
          expect({ status: res.status, ok: res.status >= 200 && res.status < 300 }).toEqual({ status: res.status, ok: true });
        } else {
          expect(res.status).toBe(403);
        }
      }, TIMEOUT);
    }
  }

  it('ADMIN in project A and VIEWER in project B gets VIEWER rights in B', async () => {
    const ref = await ticketIn('CREATED', 'team');
    await request(server).delete(`/api/projects/team/tickets/${ref}`).set(auth('multi')).expect(403);
    await request(server).post(`/api/projects/team/tickets`).set(auth('multi')).send({ type: 'BUG', title: 'x' }).expect(403);
    const alphaRef = await ticketIn('CREATED', 'alpha');
    await request(server).delete(`/api/projects/alpha/tickets/${alphaRef}`).set(auth('multi')).expect(200);
  }, TIMEOUT);

  it('a forged projectRole claim in an otherwise valid JWT is ignored', async () => {
    const signer = app.get(JwtStrategyProvider);
    const forged = await signer.sign({ sub: ids.pviewer, email: 'pviewer@koda.test', role: 'MEMBER', tokenVersion: 0, projectRole: 'ADMIN' });
    const ref = await ticketIn('CREATED');
    await request(server).delete(`/api/projects/team/tickets/${ref}`).set({ Authorization: `Bearer ${forged}` }).expect(403);
    // The forged token itself is valid: a read succeeds.
    await request(server).get(`/api/projects/team/tickets/${ref}`).set({ Authorization: `Bearer ${forged}` }).expect(200);
  }, TIMEOUT);

  it('close without a reason is 400 for a project ADMIN and leaves the ticket open', async () => {
    const ref = await ticketIn('IN_PROGRESS');
    await request(server).post(`/api/projects/team/tickets/${ref}/close`).set(auth('padmin')).send({ body: '   ' }).expect(400);
    const res = await request(server).get(`/api/projects/team/tickets/${ref}`).set(auth('padmin')).expect(200);
    expect(data<{ status: string }>(res).status).toBe('IN_PROGRESS');
  }, TIMEOUT);

  it('close writes the reason as a GENERAL comment', async () => {
    const ref = await ticketIn('IN_PROGRESS');
    await request(server).post(`/api/projects/team/tickets/${ref}/close`).set(auth('padmin')).send({ body: 'duplicate of TEAM-1' }).expect(200);
    const res = await request(server).get(`/api/projects/team/tickets/${ref}/comments`).set(auth('padmin')).expect(200);
    expect(data<Array<{ body: string; type: string }>>(res)).toEqual(
      expect.arrayContaining([expect.objectContaining({ body: 'duplicate of TEAM-1', type: 'GENERAL' })]),
    );
  }, TIMEOUT);

  it.each([
    ['ADMIN', ['start', 'reject', 'close']],
    ['DEVELOPER', ['start', 'reject']],
    ['VIEWER', []],
  ] as const)('GET ticket returns allowedActions for project %s', async (role, expected) => {
    const ref = await ticketIn('VERIFIED');
    const res = await request(server).get(`/api/projects/team/tickets/${ref}`).set(auth(whoFor[role])).expect(200);
    expect(data<{ allowedActions: string[] }>(res).allowedActions).toEqual(expected);
  }, TIMEOUT);

  it('assignee resolves to the member name on detail and list', async () => {
    const ref = await ticketIn('CREATED');
    await asRoot('post', `/api/projects/team/tickets/${ref}/assign`, { userId: ids.pdev }).expect(200);
    const detail = await request(server).get(`/api/projects/team/tickets/${ref}`).set(auth('pdev')).expect(200);
    expect(data<{ assignee: unknown }>(detail).assignee).toEqual({ kind: 'user', id: ids.pdev, name: 'pdev' });
    const list = await request(server).get('/api/projects/team/tickets?assignedTo=self').set(auth('pdev')).expect(200);
    expect(data<{ records: Array<{ ref: string; assignee: unknown }> }>(list).records.find((r) => r.ref === ref)?.assignee)
      .toEqual({ kind: 'user', id: ids.pdev, name: 'pdev' });
  }, TIMEOUT);

  it('members page reports viewerRole for the caller', async () => {
    const res = await request(server).get('/api/projects/team/members').set(auth('pdev')).expect(200);
    expect(data<{ viewerRole: string; canManage: boolean }>(res)).toEqual(expect.objectContaining({ viewerRole: 'DEVELOPER', canManage: false }));
  }, TIMEOUT);
});
