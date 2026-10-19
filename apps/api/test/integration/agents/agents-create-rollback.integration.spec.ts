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

  /** The `AGENT` bindings that exist right now, as an order-independent id set. */
  async function agentBindingIds(): Promise<string[]> {
    const rows = await prisma.client.roleBinding.findMany({
      where: { principalType: 'AGENT' },
      select: { id: true },
    });
    return rows.map((row) => row.id).sort();
  }

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

    // Permissions P1 (US-009): `POST /agents` now checks `agent.create` through `PermissionService`,
    // which reads the caller's rows — a synthetic principal with `role: 'ADMIN'` grants nothing on its
    // own. The principal the guard injects therefore names a real admin user.
    await prisma.client.user.create({
      data: {
        id: adminUser.id,
        email: adminUser.email,
        name: adminUser.name,
        passwordHash: 'not-used-by-the-injected-principal',
        role: 'ADMIN',
      },
    });

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
    const bindingsBefore = await agentBindingIds();

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

    // AC25: the rollback takes the new agent's baseline binding with it.
    expect(await agentBindingIds()).toEqual(bindingsBefore);
  });

  it('AC7 boundary: a failing agentCapabilityEntry.createMany also rolls back the agent row', async () => {
    const bindingsBefore = await agentBindingIds();

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

    // AC25: the rollback takes the new agent's baseline binding with it.
    expect(await agentBindingIds()).toEqual(bindingsBefore);
  });

  /**
   * US-004 AC25 — the third rollback source: the baseline binding itself. The binding is written last
   * inside the create transaction, so this also proves it is *inside* that transaction rather than a
   * separate write that would survive a rollback.
   */
  it('AC25: a failing baseline-binding write rolls back the agent row and leaves no binding', async () => {
    const bindingsBefore = await agentBindingIds();

    await prisma.client.$executeRawUnsafe('ALTER TABLE "RoleBinding" RENAME TO "RoleBinding_disabled"');
    try {
      const res = await request(app.getHttpServer())
        .post('/api/agents')
        .send({
          name: 'Binding Failure Agent',
          slug: 'binding-failure-agent',
          roles: ['DEVELOPER'],
          capabilities: ['typescript'],
        });

      expect(res.status).toBe(500);
    } finally {
      await prisma.client.$executeRawUnsafe('ALTER TABLE "RoleBinding_disabled" RENAME TO "RoleBinding"');
    }

    expect(await prisma.client.agent.findUnique({ where: { slug: 'binding-failure-agent' } })).toBeNull();
    expect(await prisma.client.agentRoleEntry.count()).toBe(0);
    expect(await prisma.client.agentCapabilityEntry.count()).toBe(0);
    expect(await agentBindingIds()).toEqual(bindingsBefore);
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
    // US-004: the successful create committed exactly one new AGENT baseline binding.
    expect(await agentBindingIds()).toHaveLength(1);
  });
});
