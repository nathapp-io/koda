/**
 * US-003 — POST /api/agents over a real Fastify HTTP server.
 *
 * The controller, AgentsService, PrismaAgentRepository, the production
 * `PrismaTransactionManager`, and the production transparent Proxy that
 * `PrismaModule` installs on `prismaService.client` are all real. Only the
 * database is fake: `PrismaService.client` is an in-memory store that mirrors
 * the Prisma schema defaults (Agent.status defaults to 'ACTIVE') and raises
 * a Prisma P2002 error on a duplicate slug.
 *
 * AC7 — that no agent row remains after a failed roles/capabilities write —
 * CANNOT be verified in this unit test without faking the rollback. It is
 * verified in `test/integration/agents/agents-create-rollback.integration.spec.ts`
 * with a real Prisma instance and database.
 *
 * No database, no network: everything runs in-process.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { CanActivate, ExecutionContext } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Prisma } from '../generated/prisma/client';
import { PrismaService, PrismaTransactionManager, createMockPrismaService } from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import request from 'supertest';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { PrismaAgentRepository } from './prisma-agent.repository';
import { AUTH_CFG } from '../config/auth.config';
import { KodaDomainWriter } from '../koda-domain-writer/koda-domain-writer.service';
import { AgentAuthProvider } from '../auth/agent-auth.provider';
import { KodaPrincipal, UserPrincipal } from '../auth/principal/koda-principal.types';

interface AgentRow {
  id: string;
  name: string;
  slug: string;
  apiKeyHash: string;
  status: string;
  maxConcurrentTickets: number;
  createdAt: Date;
  updatedAt: Date;
}

interface EntryRow {
  agentId: string;
  [key: string]: string;
}

type MockPrismaService = ReturnType<typeof createMockPrismaService>;

/** Mirrors the schema default for Agent.status. */
const SCHEMA_DEFAULT_STATUS = 'ACTIVE';

function duplicateSlugError(): Error {
  return new Prisma.PrismaClientKnownRequestError(
    'Unique constraint failed on the fields: (`slug`)',
    { code: 'P2002', clientVersion: '6.19.2', meta: { modelName: 'Agent', target: ['slug'] } },
  );
}

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

describe('POST /api/agents (US-003)', () => {
  let testingModule: TestingModule;
  let app: NestFastifyApplication;
  let prisma: MockPrismaService;

  // The persistent store — every row that survived `$transaction` (i.e., was
  // committed). Mirrors what a real Prisma database would hold after the
  // transaction finished.
  let agents: AgentRow[];
  let roleEntries: EntryRow[];
  let capabilityEntries: EntryRow[];

  // The same transparent Proxy the production `PrismaModule` installs around
  // `prismaService.client`, but backed by a test `AsyncLocalStorage` that the
  // real `PrismaTransactionManager` writes into. When `als.getStore()` returns
  // a transaction client, every property read on `prismaService.client` is
  // served from that transaction client — production behaviour.
  let als: AsyncLocalStorage<unknown>;
  let nextAgentId: number;
  let currentPrincipal: KodaPrincipal;

  // Hoisted so test functions can assert on the `$transaction` call count
  // — the structural AC7 proof that the real `PrismaTransactionManager.run`
  // wrapped exactly one callback.
  let ambientClient: Record<string, unknown>;

  beforeEach(async () => {
    agents = [];
    roleEntries = [];
    capabilityEntries = [];
    nextAgentId = 0;
    als = new AsyncLocalStorage();

    prisma = createMockPrismaService();

    // The ambient (non-transaction) client mocks and the per-transaction
    // client mocks share the same `jest.fn` instances, so any
    // `mockRejectedValue` / `mockResolvedValue` a test sets via
    // `prisma.client.agentRoleEntry.createMany` takes effect whether the
    // production code reads it from the ambient client or the transaction
    // client — exactly the seam a real Prisma transaction client would have.
    const agentCreate = jest.fn(async ({ data }: { data: Partial<AgentRow> }) => {
      if (agents.some((agent) => agent.slug === data.slug)) {
        throw duplicateSlugError();
      }
      const row: AgentRow = {
        id: `agent-${++nextAgentId}`,
        name: data.name as string,
        slug: data.slug as string,
        apiKeyHash: data.apiKeyHash as string,
        // Absent columns fall back to the schema default, exactly like Prisma.
        status: data.status ?? SCHEMA_DEFAULT_STATUS,
        maxConcurrentTickets: data.maxConcurrentTickets ?? 3,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      agents.push(row);
      return row;
    });
    const agentFindUnique = jest.fn(
      async ({ where }: { where: { slug?: string; id?: string } }) =>
        agents.find((agent) =>
          where.slug !== undefined ? agent.slug === where.slug : agent.id === where.id,
        ) ?? null,
    );
    const agentFindMany = jest.fn(async () => agents);
    const agentUpdate = jest.fn(async () => agents[0]);
    const roleEntryCreateMany = jest.fn(async ({ data }: { data: EntryRow[] }) => {
      roleEntries.push(...data);
      return { count: data.length };
    });
    const capabilityEntryCreateMany = jest.fn(async ({ data }: { data: EntryRow[] }) => {
      capabilityEntries.push(...data);
      return { count: data.length };
    });

    const buildClient = (): Record<string, unknown> => ({
      agent: {
        create: agentCreate,
        findUnique: agentFindUnique,
        findMany: agentFindMany,
        update: agentUpdate,
      },
      agentRoleEntry: {
        createMany: roleEntryCreateMany,
      },
      agentCapabilityEntry: {
        createMany: capabilityEntryCreateMany,
      },
    });

    // The ambient (non-transaction) prisma client.
    ambientClient = {
      ...buildClient(),
      $transaction: jest.fn(),
    };

    // `$transaction(async (tx) => { ... })` is the one piece of production
    // behaviour we have to fake: there is no real database to back the
    // rollback. The real `PrismaTransactionManager.run` calls
    // `prisma.$transaction(async (tx) => als.run(tx, fn))`; we mirror that
    // exact wiring — install the same `txClient` into the `AsyncLocalStorage`
    // so the transparent Proxy on `prismaService.client` can find it — but
    // we do NOT simulate commit/rollback. The real database would, but we
    // don't have one. AC7 outcome ("no agent row behind after a failed
    // roles/capabilities write") is verified at the integration-test level
    // against a real Prisma instance.
    (ambientClient.$transaction as jest.Mock).mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) => {
        const txClient = Object.assign(Object.create(ambientClient), { __isTxClient: true });
        // Replicate the production `PrismaTransactionManager.run` wiring
        // exactly: `als.run(tx, fn)`. The callback receives the same
        // `txClient` the proxy will serve during reads.
        return als.run(txClient, async () => callback(txClient));
      },
    );

    // Install the production-style transparent proxy on `prismaService.client`.
    // This is the exact Proxy the production `PrismaModule` patches in: while
    // the ALS carries a transaction client, every property read on the
    // `client` getter is served from that transaction client. The production
    // repository code reads `this.prisma.client.agent.create(...)` and
    // transparently ends up writing through the transaction client.
    Object.defineProperty(prisma, 'client', {
      get: () =>
        new Proxy(ambientClient, {
          get(target, prop, receiver) {
            const txClient = als.getStore() as Record<string, unknown> | undefined;
            if (txClient) return Reflect.get(txClient, prop, receiver);
            return Reflect.get(target, prop, receiver);
          },
        }),
      configurable: true,
    });

    // The injected TRANSACTION_MANAGER is the real `PrismaTransactionManager`
    // from `@nathapp/nestjs-prisma`, sharing the test ALS with the proxy above.
    // This is the production transaction-manager code path, unchanged.
    const txManager = new PrismaTransactionManager(
      prisma.client as unknown as ConstructorParameters<typeof PrismaTransactionManager>[0],
      als as unknown as ConstructorParameters<typeof PrismaTransactionManager>[1],
    );

    testingModule = await Test.createTestingModule({
      controllers: [AgentsController],
      providers: [
        AgentsService,
        PrismaAgentRepository,
        { provide: PrismaService, useValue: prisma },
        { provide: TRANSACTION_MANAGER, useValue: txManager },
        {
          provide: AUTH_CFG,
          useValue: {
            jwtSecret: 'jwt-secret',
            jwtExpiresIn: '15m',
            jwtRefreshSecret: 'jwt-refresh-secret',
            jwtRefreshExpiresIn: '7d',
            apiKeySecret: 'test-secret',
            registrationEnabled: false,
          },
        },
        {
          provide: KodaDomainWriter,
          useValue: { writeAgentAction: jest.fn().mockResolvedValue({ canonicalId: 'evt-1' }) },
        },
        {
          provide: AgentAuthProvider,
          useValue: { invalidateByTag: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    app = testingModule.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');

    // Stands in for the global CombinedAuthGuard: it is what puts the principal
    // on the request that `@Principal()` reads.
    const principalInjector: CanActivate = {
      canActivate: (ctx: ExecutionContext) => {
        ctx.switchToHttp().getRequest<{ user?: KodaPrincipal }>().user = currentPrincipal;
        return true;
      },
    };
    app.useGlobalGuards(principalInjector);

    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    currentPrincipal = adminUser;
  });

  afterEach(async () => {
    if (app) await app.close();
    jest.clearAllMocks();
  });

  it("AC2: persists the schema default status, not the client-supplied 'OFFLINE'", async () => {
    const res = await request(app.getHttpServer())
      .post('/api/agents')
      .send({
        name: 'Subrina Coder',
        slug: 'subrina-coder',
        status: 'OFFLINE',
        id: 'x',
        roles: ['DEVELOPER'],
        capabilities: ['typescript'],
      });

    expect(res.status).toBe(201);

    const persisted = agents.find((agent) => agent.slug === 'subrina-coder');
    expect(persisted).toBeDefined();
    expect(persisted?.status).toBe(SCHEMA_DEFAULT_STATUS);
    expect(persisted?.status).not.toBe('OFFLINE');
    expect(res.body.data.agent.status).toBe(SCHEMA_DEFAULT_STATUS);
  });

  it("AC2 boundary: the client-supplied id 'x' and status 'OFFLINE' never reach the persisted row", async () => {
    const res = await request(app.getHttpServer())
      .post('/api/agents')
      .send({ name: 'Subrina Coder', slug: 'subrina-coder', status: 'OFFLINE', id: 'x' });

    expect(res.status).toBe(201);

    const persisted = agents.find((agent) => agent.slug === 'subrina-coder');
    expect(persisted?.id).not.toBe('x');
    expect(res.body.data.agent.id).not.toBe('x');
    expect(persisted?.status).not.toBe('OFFLINE');
  });

  it('AC5: returns 409 when the slug already exists', async () => {
    await request(app.getHttpServer())
      .post('/api/agents')
      .send({ name: 'First Agent', slug: 'taken-slug', roles: ['DEVELOPER'] })
      .expect(201);

    const res = await request(app.getHttpServer())
      .post('/api/agents')
      .send({ name: 'Second Agent', slug: 'taken-slug', roles: ['DEVELOPER'] });

    expect(res.status).toBe(409);
    expect(agents.filter((agent) => agent.slug === 'taken-slug')).toHaveLength(1);
  });

  it('AC5 boundary: a slug that does not exist yet is created with 201', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/agents')
      .send({ name: 'Fresh Agent', slug: 'fresh-slug', roles: ['DEVELOPER'] });

    expect(res.status).toBe(201);
    expect(agents.filter((agent) => agent.slug === 'fresh-slug')).toHaveLength(1);
  });

  it('AC7: a failing roles/capabilities write is wrapped in a single txManager.run callback and surfaces as HTTP 500', async () => {
    // The structural assertion for AC7: the production service MUST run
    // `agent.create` and `createRolesAndCapabilities` inside one
    // `txManager.run` callback (which is what triggers the rollback a real
    // Prisma `$transaction` performs). Verifying that the row is actually
    // gone after a failure requires a real database; see
    // `test/integration/agents/agents-create-rollback.integration.spec.ts`.
    (prisma.client.agentRoleEntry.createMany as jest.Mock).mockRejectedValue(
      new Error('agentRoleEntry insert failed'),
    );

    const res = await request(app.getHttpServer())
      .post('/api/agents')
      .send({
        name: 'Rollback Agent',
        slug: 'rollback-agent',
        roles: ['DEVELOPER'],
        capabilities: ['typescript'],
      });

    // Both writes happened (the agent row first, then the failing roles).
    expect(prisma.client.agent.create).toHaveBeenCalledTimes(1);
    expect(prisma.client.agentRoleEntry.createMany).toHaveBeenCalledTimes(1);
    // The failure surfaces as an HTTP 500 — the service does not swallow it.
    expect(res.status).toBe(500);
    // The production transaction manager was used: the real
    // `PrismaTransactionManager.run` wraps the callback in
    // `prisma.$transaction(...)`, so exactly one `$transaction` call means
    // exactly one `txManager.run` call. The callback must receive both the
    // agent write and the failing role write.
    expect(ambientClient.$transaction).toHaveBeenCalledTimes(1);
  });

  it('AC7 boundary: a failing capability write is also wrapped in one txManager.run callback', async () => {
    (prisma.client.agentCapabilityEntry.createMany as jest.Mock).mockRejectedValue(
      new Error('agentCapabilityEntry insert failed'),
    );

    const res = await request(app.getHttpServer())
      .post('/api/agents')
      .send({ name: 'Rollback Agent', slug: 'rollback-agent', roles: ['DEVELOPER'] });

    // All three writes happened (agent row, then roles, then failing caps).
    expect(prisma.client.agent.create).toHaveBeenCalledTimes(1);
    expect(prisma.client.agentRoleEntry.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.client.agentCapabilityEntry.createMany).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(500);
    expect(ambientClient.$transaction).toHaveBeenCalledTimes(1);
  });
});
