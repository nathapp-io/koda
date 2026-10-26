import { canRunDbTests } from '../../helpers/test-environment';
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import type { Mock } from 'vitest';
import { vi } from 'vitest';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { SKILL_RESOLVER, SkillResolveError, SkillResolver } from '../../../src/skills/skill-resolver';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { grantBaseline } from '../../../src/permissions/test-helpers/permission-fixtures';
import { bootHttpApp, data, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { fixtureDb } from '../../helpers/action-context';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('skill writes audit (real AppModule)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let server: Parameters<typeof request>[0];
  let rootToken: string;
  let rootId: string;
  let projectId: string;
  let resolve: Mock;
  let recorder: AuditRecorder;
  let recordSpy: ReturnType<typeof vi.spyOn> | undefined;

  const auth = (token = rootToken) => ({ Authorization: `Bearer ${token}` });
  const sourceBody = (path: string) => ({ gitUrl: 'https://github.com/acme/skills', ref: 'main', path });
  const createSource = async (path: string, skills = [{ name: `audit-${path.slice(-1)}`, description: 'd', dir: path }], token = rootToken) => {
    resolve.mockResolvedValue({ sha: 's1', skills });
    return data<{ id: string; status: string }>(await request(server).post('/api/admin/skills/sources').set(auth(token)).send(sourceBody(path)).expect(201));
  };
  const entry = (key: string, resourceId: string) => db.auditEntry.findFirstOrThrow({ where: { key, resourceId } });
  const failAuditFor = (key: string) => {
    const originalRecord = recorder.record.bind(recorder);
    recordSpy = vi.spyOn(recorder, 'record').mockImplementation(async (input) => {
      if (input.key === key) throw new Error('audit down');
      return originalRecord(input);
    });
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    db = fixtureDb(app);
    recorder = app.get(AuditRecorder);
    const rootRes = await request(server).post('/api/auth/register').send({ email: 'skills-audit-root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    rootToken = data<{ accessToken: string }>(rootRes).accessToken;
    rootId = (await db.user.findUniqueOrThrow({ where: { email: 'skills-audit-root@koda.test' } })).id;
    await grantBaseline(db, { type: 'USER', id: rootId });
    await request(server).post('/api/projects').set(auth()).send({ name: 'Skills Audit', slug: 'sk-audit', key: 'SKA' }).expect(201);
    projectId = (await db.project.findUniqueOrThrow({ where: { slug: 'sk-audit' } })).id;
    await request(server).post('/api/admin/users').set(auth()).send({ email: 'skills-audit-dev@koda.test', name: 'Developer', password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
    const dev = await db.user.findUniqueOrThrow({ where: { email: 'skills-audit-dev@koda.test' } });
    await grantBaseline(db, { type: 'USER', id: dev.id });
    await request(server).post('/api/projects/sk-audit/members').set(auth()).send({ email: 'skills-audit-dev@koda.test', roleKey: 'developer' }).expect(201);
    const resolver = app.get<SkillResolver>(SKILL_RESOLVER, { strict: false });
    resolve = vi.spyOn(resolver, 'resolve');
  }, 60_000);

  beforeEach(async () => {
    await resetThrottle(app);
    await db.projectSkill.deleteMany();
    await db.skill.deleteMany();
    await db.skillSource.deleteMany();
    resolve.mockReset();
    recordSpy?.mockRestore();
    recordSpy = undefined;
  });
  afterAll(async () => { recordSpy?.mockRestore(); await app?.close(); });

  it('AC-1: audits a resolved source create with principal context and status/count summary', async () => {
    resolve.mockResolvedValue({ sha: 's1', skills: [{ name: 'audit-a', description: 'd', dir: 'skills/a' }] });
    const source = data<{ id: string }>(await request(server).post('/api/admin/skills/sources').set(auth()).send(sourceBody('skills/a')).expect(201));
    expect(await db.auditEntry.count({ where: { key: 'skill.source.create', resourceId: source.id } })).toBe(1);
    expect(await entry('skill.source.create', source.id)).toMatchObject({ resourceType: 'skill-source', projectId: null, actorType: 'USER', actorId: rootId, origin: 'rest', summary: 'created, status OK, skills 1' });
  });

  it('AC-2: audits a failed source resolution with zero skills', async () => {
    resolve.mockRejectedValue(new SkillResolveError('rate_limited'));
    const source = data<{ id: string; status: string }>(await request(server).post('/api/admin/skills/sources').set(auth()).send(sourceBody('skills/b')).expect(201));
    expect(source.status).toBe('RESOLVE_FAILED');
    expect(await entry('skill.source.create', source.id)).toMatchObject({ summary: 'created, status RESOLVE_FAILED, skills 0' });
  });

  it('AC-3: duplicate source refusal does not add an audit entry', async () => {
    await createSource('skills/a');
    const before = await db.auditEntry.count({ where: { key: 'skill.source.create' } });
    await request(server).post('/api/admin/skills/sources').set(auth()).send(sourceBody('skills/a')).expect(409);
    expect(await db.auditEntry.count({ where: { key: 'skill.source.create' } })).toBe(before);
  });

  it('AC-4: rejected create audit rolls back the source', async () => {
    failAuditFor('skill.source.create');
    const response = await request(server).post('/api/admin/skills/sources').set(auth()).send(sourceBody('skills/c'));
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(await db.skillSource.count({ where: { path: 'skills/c' } })).toBe(0);
  });

  it('AC-5: audits a successful update with resulting status and skill count', async () => {
    const source = await createSource('skills/a', [{ name: 'audit-a', description: 'd', dir: 'skills/a' }]);
    resolve.mockResolvedValue({ sha: 's2', skills: [{ name: 'audit-a', description: 'd', dir: 'skills/a' }, { name: 'audit-a2', description: 'd', dir: 'skills/a2' }] });
    await request(server).post(`/api/admin/skills/sources/${source.id}/update`).set(auth()).send({}).expect(200);
    expect(await entry('skill.source.update', source.id)).toMatchObject({ resourceType: 'skill-source', projectId: null, summary: 'updated, status OK, skills 2' });
  });

  it('AC-6: audits a failed update resolution', async () => {
    const source = await createSource('skills/a');
    resolve.mockRejectedValue(new SkillResolveError('ref_not_found'));
    await request(server).post(`/api/admin/skills/sources/${source.id}/update`).set(auth()).send({}).expect(200);
    expect((await entry('skill.source.update', source.id)).summary).toMatch(/^updated, status RESOLVE_FAILED, skills \d+$/);
  });

  it('AC-7: rejected update audit rolls back resolution changes', async () => {
    const source = await createSource('skills/a');
    failAuditFor('skill.source.update');
    resolve.mockResolvedValue({ sha: 's3', skills: [{ name: 'audit-a', description: 'd', dir: 'skills/a' }] });
    const response = await request(server).post(`/api/admin/skills/sources/${source.id}/update`).set(auth()).send({});
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect((await db.skillSource.findUniqueOrThrow({ where: { id: source.id } })).resolvedSha).toBe('s1');
  });

  it('AC-8: audits source deletion', async () => {
    const source = await createSource('skills/a');
    await request(server).delete(`/api/admin/skills/sources/${source.id}`).set(auth()).expect(204);
    expect(await entry('skill.source.delete', source.id)).toMatchObject({ resourceType: 'skill-source', projectId: null, summary: 'deleted' });
  });

  it('AC-9: missing source deletion returns 404 without an entry', async () => {
    await request(server).delete('/api/admin/skills/sources/missing-source').set(auth()).expect(404);
    expect(await db.auditEntry.count({ where: { key: 'skill.source.delete', resourceId: 'missing-source' } })).toBe(0);
  });

  it('AC-10: audits project skill enablement', async () => {
    const source = await createSource('skills/a');
    const skill = await db.skill.findFirstOrThrow({ where: { sourceId: source.id } });
    await request(server).put(`/api/projects/sk-audit/skills/${skill.id}`).set(auth()).send({}).expect(200);
    expect(await entry('skill.project.enable', skill.id)).toMatchObject({ resourceType: 'skill', projectId, summary: 'enabled' });
  });

  it('AC-11: audits project skill disablement', async () => {
    const source = await createSource('skills/a');
    const skill = await db.skill.findFirstOrThrow({ where: { sourceId: source.id } });
    await request(server).put(`/api/projects/sk-audit/skills/${skill.id}`).set(auth()).send({}).expect(200);
    await request(server).delete(`/api/projects/sk-audit/skills/${skill.id}`).set(auth()).expect(204);
    expect(await entry('skill.project.disable', skill.id)).toMatchObject({ resourceType: 'skill', projectId, summary: 'disabled' });
  });

  it('AC-12: missing skill enable returns 404 without an entry', async () => {
    await request(server).put('/api/projects/sk-audit/skills/missing-skill').set(auth()).send({}).expect(404);
    expect(await db.auditEntry.count({ where: { key: 'skill.project.enable', resourceId: 'missing-skill' } })).toBe(0);
  });

  it('AC-14: rejected project enable audit rolls back the enablement', async () => {
    const source = await createSource('skills/a');
    const skill = await db.skill.findFirstOrThrow({ where: { sourceId: source.id } });
    failAuditFor('skill.project.enable');
    const response = await request(server).put(`/api/projects/sk-audit/skills/${skill.id}`).set(auth()).send({});
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(await db.projectSkill.count({ where: { projectId, skillId: skill.id } })).toBe(0);
  });

  it('AC-15: rejected source delete audit rolls back deletion', async () => {
    const source = await createSource('skills/a');
    failAuditFor('skill.source.delete');
    const response = await request(server).delete(`/api/admin/skills/sources/${source.id}`).set(auth());
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(await db.skillSource.findUnique({ where: { id: source.id } })).not.toBeNull();
  });
});
