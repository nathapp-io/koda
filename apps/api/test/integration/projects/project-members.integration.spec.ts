/**
 * Slice 4 — /projects/:slug/members on real Postgres over HTTP.
 * Run: cd apps/api && bun run test:db:up && bun run test:integration -- test/integration/projects/project-members
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

interface Member { userId: string; email: string; role: string }
interface Page<T> { total: number; records: T[] }

describeIntegration('/projects/:slug/members (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const base = '/api/projects/team/members';
  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();

    const root = await request(server).post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    tokens.root = data<{ accessToken: string }>(root).accessToken;

    await request(server).post('/api/projects').set(auth('root'))
      .send({ name: 'Team', slug: 'team', key: 'TEAM' }).expect(201);

    for (const who of ['pa', 'dev', 'viewer', 'outsider']) {
      const res = await request(server).post('/api/admin/users').set(auth('root'))
        .send({ email: `${who}@koda.test`, name: who, password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
      ids[who] = data<{ id: string }>(res).id;
      tokens[who] = await loginToken(server, `${who}@koda.test`);
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('a global admin adds a project admin and a developer', async () => {
    const pa = data<Member>(await request(server).post(base).set(auth('root')).send({ email: 'pa@koda.test', role: 'ADMIN' }).expect(201));
    expect(pa).toEqual(expect.objectContaining({ userId: ids.pa, role: 'ADMIN' }));
    await request(server).post(base).set(auth('root')).send({ email: 'dev@koda.test', role: 'DEVELOPER' }).expect(201);
  });

  it('unknown email is 404; an existing member is 409 (lookup is case-insensitive)', async () => {
    await request(server).post(base).set(auth('root')).send({ email: 'ghost@koda.test', role: 'VIEWER' }).expect(404);
    await request(server).post(base).set(auth('root')).send({ email: 'DEV@KODA.TEST', role: 'VIEWER' }).expect(409);
  });

  it('a DEVELOPER can list but cannot add members', async () => {
    const page = data<Page<Member>>(await request(server).get(base).set(auth('dev')).expect(200));
    expect(page.total).toBe(2);
    await request(server).post(base).set(auth('dev')).send({ email: 'viewer@koda.test', role: 'VIEWER' }).expect(403);
  });

  it('a non-member cannot list members', async () => {
    await request(server).get(base).set(auth('outsider')).expect(403);
  });

  it('a project admin adds a viewer and changes their role', async () => {
    await request(server).post(base).set(auth('pa')).send({ email: 'viewer@koda.test', role: 'VIEWER' }).expect(201);
    const updated = data<Member>(await request(server).patch(`${base}/${ids.viewer}`).set(auth('pa')).send({ role: 'DEVELOPER' }).expect(200));
    expect(updated.role).toBe('DEVELOPER');
  });

  it('the last project ADMIN cannot demote or remove themselves; a global admin can', async () => {
    await request(server).patch(`${base}/${ids.pa}`).set(auth('pa')).send({ role: 'DEVELOPER' }).expect(409);
    await request(server).delete(`${base}/${ids.pa}`).set(auth('pa')).expect(409);

    await request(server).patch(`${base}/${ids.pa}`).set(auth('root')).send({ role: 'DEVELOPER' }).expect(200);
  });

  it('removal takes effect on the next request (membership is not cached)', async () => {
    await request(server).get(base).set(auth('viewer')).expect(200);
    await request(server).delete(`${base}/${ids.viewer}`).set(auth('root')).expect(200);
    await request(server).get(base).set(auth('viewer')).expect(403);
    await request(server).delete(`${base}/${ids.viewer}`).set(auth('root')).expect(404);
  });

  it('a disabled project ADMIN does not count as an active admin', async () => {
    // pa was demoted to DEVELOPER above; restore ADMIN and add a second admin.
    await request(server).patch(`${base}/${ids.pa}`).set(auth('root')).send({ role: 'ADMIN' }).expect(200);
    await request(server).post(base).set(auth('root')).send({ email: 'viewer@koda.test', role: 'ADMIN' }).expect(201);
    await request(server).patch(`/api/admin/users/${ids.viewer}`).set(auth('root')).send({ disabled: true }).expect(200);

    // viewer is disabled, so pa is the only active project ADMIN: self-demotion is refused.
    // Before the active-only count this returned 200 and the project lost its last active admin.
    await request(server).patch(`${base}/${ids.pa}`).set(auth('pa')).send({ role: 'DEVELOPER' }).expect(409);
  });

  it('rejects an unassignable role with 400', async () => {
    await request(server).post(base).set(auth('root')).send({ email: 'outsider@koda.test', role: 'AGENT' }).expect(400);
  });
});
