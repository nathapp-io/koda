import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { seedThreadJob } from '../../helpers/thread-fixtures';
import { FLEET_CFG, type IFleetConfig } from '../../../src/config/fleet.config';
import { SkillsService } from '../../../src/skills/skills.service';

const describeDb = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
describeDb('workspace turns and archive', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const create = async (token = world.tokens.dev) => data<{ id: string; skills: unknown }>(await request(server).post('/api/threads').set(as(token)).send({ title: 'Personal', homeProject: 'web', backend: { kind: 'native' } }).expect(201));
  const send = (id: string, token = world.tokens.dev) => request(server).post(`/api/threads/${id}/messages`).set(as(token)).send({ text: 'hello', clientMessageId: 'cm1' });
  beforeAll(async () => {
    await resetDb(); app = await bootHttpApp({ registrationEnabled: false }); await app.init();
    server = app.getHttpServer(); prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    app.get<IFleetConfig>(FLEET_CFG, { strict: false }).threadsEnabled = true;
  }, 60000);
  afterAll(async () => { await app?.close(); });

  it('AC-1/2/3: sends on the home anchor, with workspace-only instructions, and deduplicates', async () => {
    const newer = await prisma.fleetRepo.create({ data: { projectId: world.projectId, provider: 'github', owner: 'acme', name: 'newer', defaultBranch: 'main', githubInstallationId: BigInt(77), createdById: world.ids.root, createdAt: new Date(Date.now() + 1000) } });
    const thread = await create();
    const result = data<{ jobId: string }>(await send(thread.id).expect(201));
    const job = await prisma.fleetJob.findUniqueOrThrow({ where: { id: result.jobId }, include: { threadTurn: true } });
    expect(job).toMatchObject({ projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'THREAD', feature: `thread-${thread.id}` });
    expect(job.threadTurn?.instructions).toMatch(/^You are a brainstorming partner in a koda workspace thread\./);
    expect(job.threadTurn?.instructions).not.toContain('Project brief:');
    const duplicate = data<{ message: { id: string } }>(await send(thread.id).expect(200));
    expect(duplicate.message.id).toBe(job.threadTurn?.initialMessageId);
    expect(await prisma.chatMessage.count({ where: { threadId: thread.id } })).toBe(1);
    await prisma.fleetRepo.delete({ where: { id: newer.id } });
  });
  it('AC-5: snapshots the enabled home skills', async () => {
    const source = await prisma.skillSource.create({ data: { gitUrl: 'https://github.com/acme/skills', owner: 'acme', repo: 'skills', ref: 'main', path: 'skills', status: 'READY', resolvedSha: 'abc123', createdById: world.ids.root,
      skills: { create: [{ name: 'brainstorm', description: 'Think carefully', dir: 'brainstorm' }, { name: 'disabled', description: 'Not enabled', dir: 'disabled' }] } }, include: { skills: true } });
    try {
      const skill = source.skills.find(item => item.name === 'brainstorm');
      if (!skill) throw new Error('Missing seeded brainstorm skill');
      await prisma.projectSkill.create({ data: { projectId: world.projectId, skillId: skill.id, enabledById: world.ids.root } });
      const expected = await app.get(SkillsService).snapshotForProject(world.projectId);
      expect(expected).toHaveLength(1);
      const thread = await create();
      expect(thread.skills).toEqual(expected);
      expect(JSON.stringify(thread.skills)).toContain('brainstorm');
      expect(JSON.stringify(thread.skills)).not.toContain('disabled');
      expect((await prisma.chatThread.findUniqueOrThrow({ where: { id: thread.id } })).skills).toEqual(expected);
    } finally { await prisma.skillSource.delete({ where: { id: source.id } }); }
  });
  it('AC-6: another creator is hidden and creates no message', async () => {
    const thread = await create();
    const res = await send(thread.id, world.tokens.root).expect(404);
    expect(res.body.message).toBe('Thread not found');
    expect(await prisma.chatMessage.count({ where: { threadId: thread.id } })).toBe(0);
  });
  it.each(['VIEWER', null])('AC-7/8: refuses lost hosting permission (%s)', async (role) => {
    const thread = await create();
    const member = await prisma.projectMember.findFirstOrThrow({ where: { projectId: world.projectId, userId: world.ids.dev } });
    try {
      if (role) await prisma.projectMember.update({ where: { id: member.id }, data: { role } });
      else await prisma.projectMember.delete({ where: { id: member.id } });
      const res = await send(thread.id).expect(403);
      expect(res.body.message).toBe('You cannot create jobs in this home project');
      expect(await prisma.chatMessage.count({ where: { threadId: thread.id } })).toBe(0);
    } finally {
      await prisma.projectMember.upsert({ where: { id: member.id }, create: member, update: { role: member.role } });
    }
  });
  it('AC-9: even an admin cannot send after home soft deletion', async () => {
    const thread = await create(world.tokens.root);
    try {
      await prisma.project.update({ where: { id: world.projectId }, data: { deletedAt: new Date() } });
      const res = await send(thread.id, world.tokens.root).expect(403);
      expect(res.body.message).toBe('You cannot create jobs in this home project');
    } finally { await prisma.project.update({ where: { id: world.projectId }, data: { deletedAt: null } }); }
  });
  it('AC-10: no anchor answers 409 without a job', async () => {
    const project = await prisma.project.create({ data: { name: 'Ephemeral home', slug: 'ephemeral-home', key: 'EPH' } });
    const repo = await prisma.fleetRepo.create({ data: { projectId: project.id, provider: 'github', owner: 'acme', name: 'ephemeral', defaultBranch: 'main', githubInstallationId: BigInt(77), createdById: world.ids.root } });
    const thread = data<{ id: string }>(await request(server).post('/api/threads').set(as(world.tokens.root)).send({ title: 'No anchor', homeProject: project.slug, backend: { kind: 'native' } }).expect(201));
    await prisma.fleetRepo.delete({ where: { id: repo.id } });
    const res = await send(thread.id, world.tokens.root).expect(409);
    expect(res.body.message).toBe('This project has no repository, so a project thread cannot run');
    expect(await prisma.fleetJob.count({ where: { threadId: thread.id } })).toBe(0);
    expect(await prisma.chatMessage.count({ where: { threadId: thread.id } })).toBe(0);
  });
  it('AC-11: anchor repo budget pause refuses with no job', async () => {
    const thread = await create(); const now = new Date();
    const policy = await prisma.budgetPolicy.create({ data: { scopeType: 'repo', scopeId: world.repoId, scopeKey: `repo:${world.repoId}`, projectId: world.projectId, windowKind: 'calendar_month_utc', amountUsd: '1', createdById: world.ids.root, updatedById: world.ids.root, pausedAt: now, pausedWindowStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) } });
    try {
      const res = await send(thread.id).expect(409);
      expect(res.body.message).toContain(policy.id);
      expect(await prisma.fleetJob.count({ where: { threadId: thread.id } })).toBe(0);
    } finally { await prisma.budgetPolicy.delete({ where: { id: policy.id } }); }
  });
  it('AC-13: archive is visible on the next GET', async () => {
    const thread = await create();
    await request(server).post(`/api/threads/${thread.id}/archive`).set(as(world.tokens.dev)).send({}).expect(200);
    expect(data<{ status: string }>(await request(server).get(`/api/threads/${thread.id}`).set(as(world.tokens.dev)).expect(200)).status).toBe('ARCHIVED');
  });
  it('AC-14: archive cancels a running job using its home project', async () => {
    const seeded = await seedThreadJob(server, prisma, world, { kind: 'WORKSPACE' });
    await request(server).post(`/api/threads/${seeded.threadId}/archive`).set(as(world.tokens.dev)).send({}).expect(200);
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: seeded.jobId } })).cancelRequestedAt).not.toBeNull();
  });
  it('AC-15: archive by a non-creator admin is hidden', async () => {
    const thread = await create();
    const res = await request(server).post(`/api/threads/${thread.id}/archive`).set(as(world.tokens.root)).send({}).expect(404);
    expect(res.body.message).toBe('Thread not found');
    expect((await prisma.chatThread.findUniqueOrThrow({ where: { id: thread.id } })).status).toBe('ACTIVE');
  });
});
