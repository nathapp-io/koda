/**
 * US-005 — project skill enablement routes (PG).
 *
 * GET    /api/projects/:slug/skills          — list catalog skills + per-project enabled flag
 * PUT    /api/projects/:slug/skills/:skillId — enable (upsert) a catalog skill for a project
 * DELETE /api/projects/:slug/skills/:skillId — disable a catalog skill for a project
 *
 * GitHub is never called: catalog rows are seeded straight into Postgres.
 *
 * Run: cd apps/api && bun run test:db:up && KODA_DB_TESTS=1 npx jest --forceExit test/integration/skills/project-skills-routes.integration.spec.ts
 */
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

interface SourceProjection {
  id: string;
  gitUrl: string;
  ref: string;
  resolvedSha: string | null;
  status: string;
}

interface ProjectSkillItem {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  source: SourceProjection;
}

interface SkillPart {
  name: string;
  description: string;
  dir: string;
}

interface SkillRow extends SkillPart {
  id: string;
}

/** The refusal sentence declared in src/i18n/en/<namespace>.json for `<namespace>.<key>`. */
function i18nSentence(namespace: string, key: string): string {
  const catalog = JSON.parse(
    readFileSync(join(__dirname, '../../../src/i18n/en', `${namespace}.json`), 'utf8'),
  ) as Record<string, unknown>;
  const sentence = key
    .split('.')
    .reduce<unknown>((node, segment) => (typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[segment] : undefined), catalog);
  if (typeof sentence !== 'string') throw new Error(`${namespace}.${key} is not declared in the en catalog`);
  return sentence;
}

describeIntegration('US-005 project skill enablement routes (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;

  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let webId: string;
  let otherId: string;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const listSkills = (slug: string, token: string) =>
    request(server).get(`/api/projects/${slug}/skills`).set(auth(token));
  const enableSkill = (slug: string, skillId: string, token: string) =>
    request(server).put(`/api/projects/${slug}/skills/${skillId}`).set(auth(token)).send({});
  const disableSkill = (slug: string, skillId: string, token: string) =>
    request(server).delete(`/api/projects/${slug}/skills/${skillId}`).set(auth(token));

  /** Seeds one skill source holding `skills` and returns the source plus its rows keyed by name. */
  async function seedCatalog(
    repo: string,
    skills: SkillPart[],
    sourceOverrides: { status?: string; resolvedSha?: string | null; statusReason?: string | null } = {},
  ): Promise<{ sourceId: string; byName: Record<string, SkillRow> }> {
    const source = await prisma.skillSource.create({
      data: {
        gitUrl: `https://github.com/nathapp-io/${repo}`,
        owner: 'nathapp-io',
        repo,
        ref: 'main',
        path: '',
        status: 'OK',
        resolvedSha: 'sha-1',
        resolvedAt: new Date('2024-01-01T00:00:00.000Z'),
        createdById: ids.root,
        ...sourceOverrides,
      },
    });
    const byName: Record<string, SkillRow> = {};
    for (const skill of skills) {
      const row = await prisma.skill.create({ data: { sourceId: source.id, ...skill } });
      byName[skill.name] = { id: row.id, name: row.name, description: row.description, dir: row.dir };
    }
    return { sourceId: source.id, byName };
  }

  /** Asserts a 404 carrying the domain refusal sentence (a missing route would not). */
  function expectSkillNotFound(res: request.Response): void {
    expect(res.status).toBe(404);
    const envelope = res.body as { ret?: unknown; message?: unknown };
    expect(envelope.ret).toBeDefined();
    expect(envelope.message).toBe(i18nSentence('skills', 'notFound.404'));
  }

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;

    // The first registered user becomes the global ADMIN.
    const rootRes = await request(server)
      .post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD })
      .expect(201);
    tokens.root = data<{ accessToken: string }>(rootRes).accessToken;
    ids.root = (await prisma.user.findUniqueOrThrow({ where: { email: 'root@koda.test' } })).id;

    for (const [slug, key] of [['web', 'WEB'], ['other', 'OTHER']] as const) {
      await request(server).post('/api/projects').set(auth(tokens.root)).send({ name: slug, slug, key }).expect(201);
    }
    webId = (await prisma.project.findUniqueOrThrow({ where: { slug: 'web' } })).id;
    otherId = (await prisma.project.findUniqueOrThrow({ where: { slug: 'other' } })).id;

    for (const who of ['pa', 'dev', 'outsider']) {
      await request(server)
        .post('/api/admin/users')
        .set(auth(tokens.root))
        .send({ email: `${who}@koda.test`, name: who, password: TEST_PASSWORD, role: 'MEMBER' })
        .expect(201);
      tokens[who] = await loginToken(server, `${who}@koda.test`);
      ids[who] = (await prisma.user.findUniqueOrThrow({ where: { email: `${who}@koda.test` } })).id;
    }

    // web: pa is ADMIN, dev is DEVELOPER. other: pa and dev are DEVELOPER, no project admin.
    for (const [who, role] of [['pa', 'ADMIN'], ['dev', 'DEVELOPER']] as const) {
      await request(server)
        .post('/api/projects/web/members')
        .set(auth(tokens.root))
        .send({ email: `${who}@koda.test`, role })
        .expect(201);
    }
    for (const who of ['pa', 'dev']) {
      await request(server)
        .post('/api/projects/other/members')
        .set(auth(tokens.root))
        .send({ email: `${who}@koda.test`, role: 'DEVELOPER' })
        .expect(201);
    }

    const agentRes = await request(server)
      .post('/api/agents')
      .set(auth(tokens.root))
      .send({ name: 'Skills Agent', slug: 'skills-agent', roles: ['DEVELOPER'], capabilities: ['typescript'] })
      .expect(201);
    tokens.agent = data<{ apiKey: string }>(agentRes).apiKey;
    const agent = await prisma.agent.findUniqueOrThrow({ where: { slug: 'skills-agent' } });
    // The agent is on web's roster: AC4/AC10 still require 403 for an agent principal.
    await prisma.agentProject.create({ data: { agentId: agent.id, projectId: webId, addedById: ids.root } });
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await prisma.projectSkill.deleteMany();
    await prisma.skill.deleteMany();
    await prisma.skillSource.deleteMany();
  });

  // ── AC1 — list with per-project enabled flag ─────────────────────

  it('US-005 AC1: a DEVELOPER member sees every catalog skill with its enabled flag ordered by name', async () => {
    const { byName } = await seedCatalog('alpha-beta', [
      { name: 'alpha', description: 'Alpha skill', dir: 'alpha' },
      { name: 'beta', description: 'Beta skill', dir: 'beta' },
    ]);
    await prisma.projectSkill.create({ data: { projectId: webId, skillId: byName.beta.id, enabledById: ids.pa } });

    const items = data<{ items: ProjectSkillItem[] }>(await listSkills('web', tokens.dev).expect(200)).items;

    expect(items.map((item) => [item.name, item.enabled])).toEqual([['alpha', false], ['beta', true]]);
  });

  it('US-005 AC1 boundary: an empty catalog yields no items', async () => {
    const items = data<{ items: ProjectSkillItem[] }>(await listSkills('web', tokens.dev).expect(200)).items;

    expect(items).toEqual([]);
  });

  // ── AC2 — source projection ──────────────────────────────────────

  it('US-005 AC2: each item carries the five-field source projection of its skill source', async () => {
    const { sourceId, byName } = await seedCatalog('source-projection', [{ name: 'gamma', description: 'Gamma', dir: 'gamma' }]);

    const items = data<{ items: ProjectSkillItem[] }>(await listSkills('web', tokens.dev).expect(200)).items;
    const item = items.find((candidate) => candidate.id === byName.gamma.id);

    expect(item?.source).toStrictEqual({
      id: sourceId,
      gitUrl: 'https://github.com/nathapp-io/source-projection',
      ref: 'main',
      resolvedSha: 'sha-1',
      status: 'OK',
    });
    expect(Object.keys(item?.source ?? {}).sort()).toEqual(['gitUrl', 'id', 'ref', 'resolvedSha', 'status']);
  });

  it('US-005 AC2 boundary: a failed-source skill projects a null resolvedSha without dropping the key', async () => {
    const { sourceId, byName } = await seedCatalog(
      'failed-source',
      [{ name: 'delta', description: 'Delta', dir: 'delta' }],
      { status: 'RESOLVE_FAILED', resolvedSha: null, statusReason: 'not_public_or_missing' },
    );

    const items = data<{ items: ProjectSkillItem[] }>(await listSkills('web', tokens.dev).expect(200)).items;
    const item = items.find((candidate) => candidate.id === byName.delta.id);

    expect(item?.source).toStrictEqual({
      id: sourceId,
      gitUrl: 'https://github.com/nathapp-io/failed-source',
      ref: 'main',
      resolvedSha: null,
      status: 'RESOLVE_FAILED',
    });
    expect(item?.source).toHaveProperty('resolvedSha', null);
  });

  // ── AC3 — non-member refused ─────────────────────────────────────

  it('US-005 AC3: an authenticated user who is not a member and not a global ADMIN gets 403', async () => {
    const res = await listSkills('web', tokens.outsider).expect(403);

    expect((res.body as { items?: unknown }).items).toBeUndefined();
  });

  it('US-005 AC3 boundary: a global ADMIN who is not a member may still list', async () => {
    await seedCatalog('admin-not-member', [{ name: 'zeta', description: 'Zeta', dir: 'zeta' }]);

    const items = data<{ items: ProjectSkillItem[] }>(await listSkills('web', tokens.root).expect(200)).items;

    expect(items.map((item) => item.name)).toEqual(['zeta']);
  });

  // ── AC4 — agent refused even on the roster ───────────────────────

  it('US-005 AC4: an agent API key on the project roster still gets 403', async () => {
    const res = await listSkills('web', tokens.agent).expect(403);

    expect((res.body as { items?: unknown }).items).toBeUndefined();
  });

  it('US-005 AC4 boundary: an agent API key not on the roster also gets 403', async () => {
    await listSkills('other', tokens.agent).expect(403);
  });

  // ── AC5 — project ADMIN enables ──────────────────────────────────

  it('US-005 AC5: a project ADMIN enables a catalog skill and gets 200 with enabled: true', async () => {
    const { byName } = await seedCatalog('enable-one', [{ name: 'epsilon', description: 'Epsilon', dir: 'epsilon' }]);

    const dto = data<ProjectSkillItem>(await enableSkill('web', byName.epsilon.id, tokens.pa).expect(200));

    expect(dto).toMatchObject({ id: byName.epsilon.id, name: 'epsilon', description: 'Epsilon', enabled: true });
  });

  it('US-005 AC5 boundary: enabling with no request body still returns 200', async () => {
    const { byName } = await seedCatalog('enable-no-body', [{ name: 'phi', description: 'Phi', dir: 'phi' }]);

    const dto = data<ProjectSkillItem>(
      await request(server).put(`/api/projects/web/skills/${byName.phi.id}`).set(auth(tokens.pa)).expect(200),
    );

    expect(dto).toMatchObject({ id: byName.phi.id, enabled: true });
  });

  // ── AC6 — enabledById is the caller ──────────────────────────────

  it('US-005 AC6: the stored ProjectSkill row records the enabling caller as enabledById', async () => {
    const { byName } = await seedCatalog('enabled-by', [{ name: 'eta', description: 'Eta', dir: 'eta' }]);

    await enableSkill('web', byName.eta.id, tokens.pa).expect(200);

    expect(await prisma.projectSkill.findMany({ where: { projectId: webId, skillId: byName.eta.id } })).toEqual([
      expect.objectContaining({ enabledById: ids.pa }),
    ]);
  });

  it('US-005 AC6 boundary: re-enabling by another admin overwrites enabledById with the latest caller', async () => {
    const { byName } = await seedCatalog('enabled-by-overwrite', [{ name: 'theta', description: 'Theta', dir: 'theta' }]);
    await enableSkill('web', byName.theta.id, tokens.pa).expect(200);

    await enableSkill('web', byName.theta.id, tokens.root).expect(200);

    expect(await prisma.projectSkill.findMany({ where: { projectId: webId, skillId: byName.theta.id } })).toEqual([
      expect.objectContaining({ enabledById: ids.root }),
    ]);
  });

  // ── AC7 — idempotent enable ──────────────────────────────────────

  it('US-005 AC7: enabling the same skill twice leaves exactly one ProjectSkill row', async () => {
    const { byName } = await seedCatalog('enable-twice', [{ name: 'iota', description: 'Iota', dir: 'iota' }]);

    await enableSkill('web', byName.iota.id, tokens.pa).expect(200);
    await enableSkill('web', byName.iota.id, tokens.pa).expect(200);

    expect(await prisma.projectSkill.count({ where: { projectId: webId, skillId: byName.iota.id } })).toBe(1);
  });

  it('US-005 AC7 boundary: the second enable stays a 200 with enabled: true', async () => {
    const { byName } = await seedCatalog('enable-twice-response', [{ name: 'kappa', description: 'Kappa', dir: 'kappa' }]);
    await enableSkill('web', byName.kappa.id, tokens.pa).expect(200);

    const dto = data<ProjectSkillItem>(await enableSkill('web', byName.kappa.id, tokens.pa).expect(200));

    expect(dto).toMatchObject({ id: byName.kappa.id, enabled: true });
  });

  // ── AC8 — global ADMIN not a member can enable ───────────────────

  it('US-005 AC8: a global ADMIN who is not a member of the project can enable a skill', async () => {
    const { byName } = await seedCatalog('global-admin-enable', [{ name: 'lambda', description: 'Lambda', dir: 'lambda' }]);

    const dto = data<ProjectSkillItem>(await enableSkill('other', byName.lambda.id, tokens.root).expect(200));

    expect(dto.enabled).toBe(true);
    expect(await prisma.projectSkill.count({ where: { projectId: otherId, skillId: byName.lambda.id } })).toBe(1);
  });

  it("US-005 AC8 boundary: the global ADMIN's enablement adds no project membership", async () => {
    const { byName } = await seedCatalog('global-admin-no-membership', [{ name: 'psi', description: 'Psi', dir: 'psi' }]);

    await enableSkill('other', byName.psi.id, tokens.root).expect(200);

    expect(await prisma.projectMember.count({ where: { projectId: otherId, userId: ids.root } })).toBe(0);
  });

  // ── AC9 — DEVELOPER member cannot enable ─────────────────────────

  it('US-005 AC9: a DEVELOPER member cannot enable a skill', async () => {
    const { byName } = await seedCatalog('developer-denied', [{ name: 'mu', description: 'Mu', dir: 'mu' }]);

    await enableSkill('web', byName.mu.id, tokens.dev).expect(403);
  });

  it('US-005 AC9 boundary: a denied DEVELOPER enable writes no row', async () => {
    const { byName } = await seedCatalog('developer-denied-row', [{ name: 'nu', description: 'Nu', dir: 'nu' }]);

    await enableSkill('web', byName.nu.id, tokens.dev).expect(403);

    expect(await prisma.projectSkill.count({ where: { projectId: webId, skillId: byName.nu.id } })).toBe(0);
  });

  // ── AC10 — agent cannot enable ───────────────────────────────────

  it('US-005 AC10: an agent API key cannot enable a skill', async () => {
    const { byName } = await seedCatalog('agent-denied', [{ name: 'xi', description: 'Xi', dir: 'xi' }]);

    await enableSkill('web', byName.xi.id, tokens.agent).expect(403);
  });

  it('US-005 AC10 boundary: the refused agent enable writes no row', async () => {
    const { byName } = await seedCatalog('agent-denied-row', [{ name: 'chi', description: 'Chi', dir: 'chi' }]);

    await enableSkill('web', byName.chi.id, tokens.agent).expect(403);

    expect(await prisma.projectSkill.count({ where: { projectId: webId, skillId: byName.chi.id } })).toBe(0);
  });

  // ── AC11 — unknown skill on PUT ──────────────────────────────────

  it('US-005 AC11: enabling an unknown skill returns 404 skills.notFound', async () => {
    const res = await enableSkill('web', '00000000-0000-4000-8000-000000000000', tokens.pa).expect(404);

    expectSkillNotFound(res);
  });

  it('US-005 AC11 boundary: the 404 writes no row for the unknown id', async () => {
    await seedCatalog('unknown-put-existing', [{ name: 'omicron', description: 'Omicron', dir: 'omicron' }]);

    await enableSkill('web', '00000000-0000-4000-8000-000000000000', tokens.pa).expect(404);

    expect(await prisma.projectSkill.count({ where: { projectId: webId } })).toBe(0);
  });

  // ── AC12 — disable removes the row ───────────────────────────────

  it('US-005 AC12: a project ADMIN disables an enabled skill with 204 and the row is gone', async () => {
    const { byName } = await seedCatalog('disable-one', [{ name: 'pi', description: 'Pi', dir: 'pi' }]);
    await enableSkill('web', byName.pi.id, tokens.pa).expect(200);

    const res = await disableSkill('web', byName.pi.id, tokens.pa).expect(204);

    expect(res.text).toBe('');
    expect(await prisma.projectSkill.count({ where: { projectId: webId, skillId: byName.pi.id } })).toBe(0);
  });

  it('US-005 AC12 boundary: the list reports the disabled skill as enabled: false', async () => {
    const { byName } = await seedCatalog('disable-then-list', [{ name: 'rho', description: 'Rho', dir: 'rho' }]);
    await enableSkill('web', byName.rho.id, tokens.pa).expect(200);
    await disableSkill('web', byName.rho.id, tokens.pa).expect(204);

    const items = data<{ items: ProjectSkillItem[] }>(await listSkills('web', tokens.dev).expect(200)).items;

    expect(items.find((item) => item.id === byName.rho.id)).toMatchObject({ enabled: false });
  });

  // ── AC13 — unknown skill on DELETE ───────────────────────────────

  it('US-005 AC13: disabling an unknown skill returns 404 skills.notFound', async () => {
    const res = await disableSkill('web', '00000000-0000-4000-8000-000000000000', tokens.pa).expect(404);

    expectSkillNotFound(res);
  });

  it('US-005 AC13 boundary: the 404 leaves existing enablements untouched', async () => {
    const { byName } = await seedCatalog('unknown-delete-existing', [{ name: 'sigma', description: 'Sigma', dir: 'sigma' }]);
    await enableSkill('web', byName.sigma.id, tokens.pa).expect(200);

    await disableSkill('web', '00000000-0000-4000-8000-000000000000', tokens.pa).expect(404);

    expect(await prisma.projectSkill.count({ where: { projectId: webId, skillId: byName.sigma.id } })).toBe(1);
  });

  // ── AC14 — enablement is per project ─────────────────────────────

  it('US-005 AC14: enabling in project A leaves the same skill disabled in project B', async () => {
    const { byName } = await seedCatalog('cross-project', [{ name: 'tau', description: 'Tau', dir: 'tau' }]);
    await enableSkill('web', byName.tau.id, tokens.pa).expect(200);

    const items = data<{ items: ProjectSkillItem[] }>(await listSkills('other', tokens.dev).expect(200)).items;

    expect(items.find((item) => item.id === byName.tau.id)).toMatchObject({ enabled: false });
  });

  it('US-005 AC14 boundary: enabling in project A writes no row for project B', async () => {
    const { byName } = await seedCatalog('cross-project-row', [{ name: 'omega', description: 'Omega', dir: 'omega' }]);

    await enableSkill('web', byName.omega.id, tokens.pa).expect(200);

    expect(await prisma.projectSkill.count({ where: { projectId: otherId, skillId: byName.omega.id } })).toBe(0);
  });

  // ── AC15 — project A's ADMIN cannot manage project B ─────────────

  it('US-005 AC15: an ADMIN of project A who is only a DEVELOPER of project B cannot enable in B', async () => {
    const { byName } = await seedCatalog('cross-admin', [{ name: 'upsilon', description: 'Upsilon', dir: 'upsilon' }]);

    await enableSkill('other', byName.upsilon.id, tokens.pa).expect(403);

    expect(await prisma.projectSkill.count({ where: { projectId: otherId, skillId: byName.upsilon.id } })).toBe(0);
  });
});
