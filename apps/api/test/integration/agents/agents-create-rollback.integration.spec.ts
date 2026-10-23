/**
 * US-003 — AC7: when PrismaAgentRepository.createCapabilities rejects during POST /api/agents, no
 * agent row with the requested slug exists afterwards. The unit test in
 * agents-create.routes.spec.ts cannot verify the outcome (it has no real database to roll back);
 * this integration test does.
 *
 * Permissions P1l (US-005): the failure seam moved from `agentRoleEntry.createMany` to
 * `agentCapabilityEntry.createMany`, because creation no longer writes a role row at all.
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
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';

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

    // `POST /agents` checks `agent.create` from bindings alone. Neither the injected principal's
    // ADMIN claim nor the legacy User.role column grants permission without an explicit binding.
    await prisma.client.user.create({
      data: {
        id: adminUser.id,
        email: adminUser.email,
        name: adminUser.name,
        passwordHash: 'not-used-by-the-injected-principal',

      },
    });
    await grantRole(prisma.client, { type: 'USER', id: adminUser.id }, 'admin');

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

  it('AC7: a failing agentCapabilityEntry.createMany rolls back the agent row (real Prisma transaction)', async () => {
    const bindingsBefore = await agentBindingIds();

    // Force the capability write to fail by renaming its table away, so the service's
    // `agentCapabilityEntry.createMany` raises a "relation does not exist" error. The table is
    // renamed back afterwards so the rest of the suite is unaffected.
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

      // The capability write failed and the service surfaces it as an HTTP 500 — it does not
      // swallow the createCapabilities error.
      expect(res.status).toBe(500);
    } finally {
      await prisma.client.$executeRawUnsafe(
        'ALTER TABLE "AgentCapabilityEntry_disabled" RENAME TO "AgentCapabilityEntry"',
      );
    }

    // The agent row must have been rolled back: no Agent row with the requested slug exists.
    expect(await prisma.client.agent.findUnique({ where: { slug: 'rollback-agent' } })).toBeNull();

    // AC-9: creation wrote no role row, in this attempt or before it.

    expect(await prisma.client.agentCapabilityEntry.count()).toBe(0);

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

    // Reject the transaction's agent-binding write while leaving authorization reads available.
    await prisma.client.$executeRawUnsafe(
      'ALTER TABLE "RoleBinding" ADD CONSTRAINT "test_reject_agent_binding" CHECK ("principalType" <> \'AGENT\') NOT VALID',
    );
    try {
      const res = await request(app.getHttpServer())
        .post('/api/agents')
        .send({
          name: 'Binding Failure Agent',
          slug: 'binding-failure-agent',
          capabilities: ['typescript'],
        });

      expect(res.status).toBe(500);
    } finally {
      await prisma.client.$executeRawUnsafe(
        'ALTER TABLE "RoleBinding" DROP CONSTRAINT "test_reject_agent_binding"',
      );
    }

    expect(await prisma.client.agent.findUnique({ where: { slug: 'binding-failure-agent' } })).toBeNull();

    expect(await prisma.client.agentCapabilityEntry.count()).toBe(0);
    expect(await agentBindingIds()).toEqual(bindingsBefore);
  });

  it('AC-9 and AC-10: a successful create writes the capability and no role row', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/agents')
      .send({
        name: 'Healthy Agent',
        slug: 'healthy-agent',
        roles: ['DEVELOPER'],
        capabilities: ['nax'],
      });

    expect(res.status).toBe(201);
    const persisted = await prisma.client.agent.findUnique({ where: { slug: 'healthy-agent' } });
    expect(persisted).not.toBeNull();
    expect(persisted?.name).toBe('Healthy Agent');
    // US-005: creation writes capabilities only.

    const capabilities = await prisma.client.agentCapabilityEntry.findMany({
      where: { agentId: persisted?.id as string },
      select: { capability: true },
    });
    expect(capabilities.map(({ capability }) => capability)).toEqual(['nax']);
    // US-004: the successful create committed exactly one new AGENT baseline binding.
    expect(await agentBindingIds()).toHaveLength(1);
  });
});
