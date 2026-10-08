/**
 * US-003 — AC7: when PrismaAgentRepository.createRolesAndCapabilities rejects
 * during POST /api/agents, no agent row with the requested slug exists
 * afterwards. The unit test in agents-create.routes.spec.ts cannot verify the
 * outcome (it has no real database to roll back); this integration test does.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:integration -- agents-create-rollback
 */
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { CanActivate, ExecutionContext } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../../src/app.module';
import { authConfig } from '../../../src/config/auth.config';
import { KodaPrincipal, UserPrincipal } from '../../../src/auth/principal/koda-principal.types';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const DATABASE_URL = process.env.DATABASE_URL;

const adminUser: UserPrincipal = {
  actorType: 'user',
  id: 'user-admin',
  name: 'admin@koda.dev',
  email: 'admin@koda.dev',
  role: 'ADMIN',
  blacklisted: false,
  revoked: false,
  authorities: ['ADMIN'],
  extra: {},
};

describeIntegration('POST /api/agents AC7 rollback (US-003)', () => {
  let module: TestingModule;
  let app: NestFastifyApplication;
  let prisma: PrismaService<PrismaClient>;

  beforeAll(async () => {
    if (!DATABASE_URL) return;

    await resetDb();

    // Use the real AppModule so the production `PrismaModule`,
    // `PrismaTransactionManager`, `AgentsController`, `AgentsService`, and
    // `PrismaAgentRepository` are all wired exactly as in production.
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [authConfig] }),
        AppModule,
      ],
    }).compile();

    prisma = module.get(PrismaService);
    await prisma.onModuleInit();

    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');

    // Replace the global CombinedAuthGuard with one that always authenticates
    // as the admin user — we are testing the rollback semantics, not auth.
    const principalInjector: CanActivate = {
      canActivate: (ctx: ExecutionContext) => {
        ctx.switchToHttp().getRequest<{ user?: KodaPrincipal }>().user = adminUser;
        return true;
      },
    };
    app.useGlobalGuards(principalInjector);

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
    if (module) await module.close();
  });

  /**
   * Force the role-entry write to fail by renaming the `AgentRoleEntry`
   * table away, so the service's `agentRoleEntry.createMany` raises a
   * "relation does not exist" error. After the request completes the table
   * is renamed back so the rest of the suite (and subsequent tests) is
   * unaffected.
   */
  async function withAgentRoleEntryUnavailable<T>(fn: () => Promise<T>): Promise<T> {
    await prisma.client.$executeRawUnsafe('ALTER TABLE "AgentRoleEntry" RENAME TO "AgentRoleEntry_disabled"');
    try {
      return await fn();
    } finally {
      await prisma.client.$executeRawUnsafe(
        'ALTER TABLE "AgentRoleEntry_disabled" RENAME TO "AgentRoleEntry"',
      );
    }
  }

  it('AC7: a failing agentRoleEntry.createMany rolls back the agent row (real Prisma transaction)', async () => {
    await withAgentRoleEntryUnavailable(async () => {
      const res = await request(app.getHttpServer())
        .post('/api/agents')
        .send({
          name: 'Rollback Agent',
          slug: 'rollback-agent',
          roles: ['DEVELOPER'],
          capabilities: ['typescript'],
        });

      // The role write must have failed (relation does not exist) and the
      // service must surface it as an HTTP 500 — it does not swallow the
      // createRolesAndCapabilities error.
      expect(res.status).toBe(500);
    });

    // The agent row must have been rolled back: no Agent row with the
    // requested slug exists. This is the AC7 outcome the unit test cannot
    // verify without faking the rollback.
    const remaining = await prisma.client.agent.findUnique({ where: { slug: 'rollback-agent' } });
    expect(remaining).toBeNull();

    const remainingRoleEntries = await prisma.client.agentRoleEntry.count();
    expect(remainingRoleEntries).toBe(0);

    const remainingCapabilityEntries = await prisma.client.agentCapabilityEntry.count();
    expect(remainingCapabilityEntries).toBe(0);
  });

  it('AC7 boundary: a failing agentCapabilityEntry.createMany also rolls back the agent row', async () => {
    await prisma.client.$executeRawUnsafe(
      'ALTER TABLE "AgentCapabilityEntry" RENAME TO "AgentCapabilityEntry_disabled"',
    );
    try {
      const res = await request(app.getHttpServer())
        .post('/api/agents')
        .send({
          name: 'Rollback Agent',
          slug: 'rollback-agent',
          roles: ['DEVELOPER'],
          capabilities: ['typescript'],
        });

      expect(res.status).toBe(500);
    } finally {
      await prisma.client.$executeRawUnsafe(
        'ALTER TABLE "AgentCapabilityEntry_disabled" RENAME TO "AgentCapabilityEntry"',
      );
    }

    const remaining = await prisma.client.agent.findUnique({ where: { slug: 'rollback-agent' } });
    expect(remaining).toBeNull();

    const remainingRoleEntries = await prisma.client.agentRoleEntry.count();
    expect(remainingRoleEntries).toBe(0);

    const remainingCapabilityEntries = await prisma.client.agentCapabilityEntry.count();
    expect(remainingCapabilityEntries).toBe(0);
  });

  it('AC7 smoke: a successful create after rollback leaves the agent row intact', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/agents')
      .send({
        name: 'Healthy Agent',
        slug: 'healthy-agent',
        roles: ['DEVELOPER'],
        capabilities: ['typescript'],
      });

    expect(res.status).toBe(201);
    const persisted = await prisma.client.agent.findUnique({ where: { slug: 'healthy-agent' } });
    expect(persisted).not.toBeNull();
    expect(persisted?.name).toBe('Healthy Agent');
  });
});
