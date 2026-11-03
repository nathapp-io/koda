import { canRunDbTests } from '../../helpers/test-environment';
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { PrismaAgentRepository } from '../../../src/agents/prisma-agent.repository';
import { PrismaAuthRepository } from '../../../src/auth/prisma-auth.repository';
import { PrismaRoleBindingRepository } from '../../../src/permissions/prisma-role-binding.repository';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, TEST_PASSWORD } from '../../helpers/http-app';
import { fixtureDb } from '../../helpers/action-context';
import { createTestPrismaClient } from '../../helpers/test-prisma';

const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('agent soft-delete reads (US-008, PG)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let raw: PrismaClient;
  let agents: PrismaAgentRepository;
  let auth: PrismaAuthRepository;
  let bindings: PrismaRoleBindingRepository;
  let ownerToken: string;
  let serial = 0;

  const makeAgent = (slug: string) => raw.agent.create({
    data: { name: slug, slug, apiKeyHash: `hash-${slug}` },
  });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    raw = createTestPrismaClient();
    const prisma = { client: raw } as unknown as PrismaService<PrismaClient>;
    agents = new PrismaAgentRepository(prisma);
    const txManager = { run: <T>(fn: () => Promise<T>) => fn() } as never;
    auth = new PrismaAuthRepository(prisma, txManager);
    bindings = new PrismaRoleBindingRepository(txManager, prisma);
    ownerToken = data<{ accessToken: string }>(await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: 'soft-read-owner@koda.test', name: 'Owner', password: TEST_PASSWORD })
      .expect(201)).accessToken;
  }, 60_000);

  afterAll(async () => { await raw?.$disconnect(); await app?.close(); });

  it('AC-1/2/3: slug, id and list finders exclude tombstones', async () => {
    const live = await makeAgent(`live-${++serial}`);
    const deleted = await makeAgent(`deleted-${serial}`);
    await raw.agent.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });

    expect(await agents.findBySlug(deleted.slug)).toBeNull();
    expect(await agents.findById(deleted.id)).toBeNull();
    expect(await agents.findBySlugWithCapabilities(deleted.slug)).toBeNull();
    expect(await agents.findBySlugScalar(deleted.slug)).toBeNull();
    expect(await agents.findByIdScalar(deleted.id)).toBeNull();
    expect((await agents.findAll()).map((agent) => agent.id)).toContain(live.id);
    expect((await agents.findAll()).map((agent) => agent.id)).not.toContain(deleted.id);
  });

  it('AC-4: project agent results exclude tombstones while preserving live assignees', async () => {
    const project = await db.project.create({
      data: { name: `soft-project-${serial}`, slug: `soft-project-${serial}`, key: `SR${serial}` },
    });
    const live = await makeAgent(`live-project-${++serial}`);
    const deleted = await makeAgent(`deleted-project-${serial}`);
    for (const agent of [live, deleted]) {
      await db.ticket.create({ data: {
        projectId: project.id, number: agent.id === live.id ? 1 : 2, type: 'TASK', title: agent.slug,
        assignedToAgentId: agent.id,
      } });
    }
    await raw.agent.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });

    const result = await agents.findByProjectSlug(project.slug);

    expect(result?.agents.map(({ id }) => id)).toContain(live.id);
    expect(result?.agents.map(({ id }) => id)).not.toContain(deleted.id);
  });

  it('AC-5/6: key-hash and direct-id auth lookups reject a tombstone', async () => {
    const agent = await makeAgent(`auth-deleted-${++serial}`);
    const hash = agent.apiKeyHash;
    await raw.agent.update({ where: { id: agent.id }, data: { deletedAt: new Date() } });

    expect(await auth.findAgentByKeyHash(hash)).toBeNull();
    expect(await auth.findAgentById(agent.id)).toBeNull();
  });

  it('AC-7: a former API key is rejected after delete, including the stored dead-key and id paths', async () => {
    const created = data<{ apiKey: string; agent: { id: string; slug: string } }>(
      await request(app.getHttpServer()).post('/api/agents').set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: `http-deleted-${++serial}`, slug: `http-deleted-${serial}` }).expect(201),
    );
    const agent = await raw.agent.findUniqueOrThrow({ where: { id: created.agent.id } });

    await request(app.getHttpServer()).delete(`/api/agents/${created.agent.slug}`)
      .set('Authorization', `Bearer ${ownerToken}`).expect(200);

    const tombstone = await raw.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(tombstone.apiKeyHash).toMatch(/^deleted:/);
    expect(await auth.findAgentByKeyHash(tombstone.apiKeyHash)).toBeNull();
    expect(await auth.findAgentById(agent.id)).toBeNull();
    await request(app.getHttpServer()).get('/api/agents/me')
      .set('Authorization', `Bearer ${created.apiKey}`).expect(401);
  });

  it('AC-8: principalExists is false for a tombstoned agent', async () => {
    const agent = await makeAgent(`binding-deleted-${++serial}`);
    await raw.agent.update({ where: { id: agent.id }, data: { deletedAt: new Date() } });

    expect(await bindings.principalExists({ type: 'AGENT', id: agent.id })).toBe(false);
  });

  it('AC-13: live id lookup retains the included capability rows', async () => {
    const agent = await makeAgent(`capabilities-live-${++serial}`);
    await raw.agentCapabilityEntry.createMany({ data: [
      { agentId: agent.id, capability: 'typescript' },
      { agentId: agent.id, capability: 'nax' },
    ] });

    const result = await agents.findById(agent.id);

    expect(result?.id).toBe(agent.id);
    expect(result?.capabilities.map(({ capability }) => capability).sort()).toEqual(['nax', 'typescript']);
  });
});
