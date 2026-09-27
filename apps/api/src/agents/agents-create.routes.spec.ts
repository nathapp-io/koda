/**
 * US-003 — POST /api/agents over a real Fastify HTTP server.
 *
 * The controller, AgentsService and PrismaAgentRepository are the real ones; only
 * the database is fake. The fake `PrismaService.client` mirrors the Prisma schema
 * defaults (Agent.status defaults to 'ACTIVE') and raises a Prisma P2002 error on
 * a duplicate slug. The `PrismaService.client` getter is wrapped in the same
 * transparent Proxy the production `PrismaModule` installs, backed by an
 * `AsyncLocalStorage` shared with the real `PrismaTransactionManager` from
 * `@nathapp/nestjs-prisma`. So the test exercises the production transaction
 * manager and proxy unchanged — only `$transaction` itself is stubbed (we have
 * no real database to roll back).
 *
 * Inside the stubbed `$transaction` the `txClient` writes to a per-transaction
 * buffer; the ambient client writes to the persistent store. On commit the
 * buffer is merged into the persistent store, on rollback it is discarded —
 * the same observable effect Prisma's real database transaction has.
 *
 * No database, no network: everything runs in-process.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { CanActivate, ExecutionContext } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Prisma } from '@prisma/client';
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

  beforeEach(async () => {
    agents = [];
    roleEntries = [];
    capabilityEntries = [];
    nextAgentId = 0;
    als = new AsyncLocalStorage();

    prisma = createMockPrismaService();

    // Per-transaction buffer. Writes inside `$transaction` land here and are
    // only merged into the persistent store above on commit; on rollback they
    // are discarded — the same observable effect Prisma's database
    // transaction has on rows read by either client.
    const txRows: {
      agents: AgentRow[];
      roleEntries: EntryRow[];
      capabilityEntries: EntryRow[];
    } = { agents: [], roleEntries: [], capabilityEntries: [] };

    // The ambient (non-transaction) client mocks and the per-transaction
    // client mocks share the same `jest.fn` instances, so any
    // `mockRejectedValue` / `mockResolvedValue` a test sets via
    // `prisma.client.agentRoleEntry.createMany` takes effect whether the
    // production code reads it from the ambient client or the transaction
    // client — exactly the seam a real Prisma transaction client would have.
    const agentCreate = jest.fn(async ({ data }: { data: Partial<AgentRow> }) => {
      // Conflict detection sees both committed rows and any pending rows
      // added by the same transaction — exactly what a real Prisma
      // transaction client would see.
      const visibleAgents = [...txRows.agents, ...agents];
      if (visibleAgents.some((agent) => agent.slug === data.slug)) {
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
      // Writes through `prisma.client` while inside a `$transaction` come
      // from the transaction client and land in the tx buffer; writes
      // outside a transaction come from the ambient client and land in the
      // persistent store directly. The split is decided by which client the
      // proxy returned for this property access — recorded here per-call.
      const inTx = als.getStore() !== undefined;
      if (inTx) {
        txRows.agents.push(row);
      } else {
        agents.push(row);
      }
      return row;
    });
    const agentFindUnique = jest.fn(
      async ({ where }: { where: { slug?: string; id?: string } }) => {
        const visibleAgents = [...txRows.agents, ...agents];
        return (
          visibleAgents.find((agent) =>
            where.slug !== undefined ? agent.slug === where.slug : agent.id === where.id,
          ) ?? null
        );
      },
    );
    const agentFindMany = jest.fn(async () => [...txRows.agents, ...agents]);
    const agentUpdate = jest.fn(async () => agents[0]);
    const roleEntryCreateMany = jest.fn(async ({ data }: { data: EntryRow[] }) => {
      const inTx = als.getStore() !== undefined;
      (inTx ? txRows : { roleEntries }).roleEntries.push(...data);
      return { count: data.length };
    });
    const capabilityEntryCreateMany = jest.fn(async ({ data }: { data: EntryRow[] }) => {
      const inTx = als.getStore() !== undefined;
      (inTx ? txRows : { capabilityEntries }).capabilityEntries.push(...data);
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

    // The ambient (non-transaction) prisma client. Writes here land directly
    // in the persistent store — there is no rollback safety net, just like a
    // real client outside a transaction.
    const ambientClient: Record<string, unknown> = {
      ...buildClient(),
      $transaction: jest.fn(),
    };

    // `$transaction(async (tx) => { ... })` is the one piece of production
    // behaviour we have to fake: there is no real database to back the
    // rollback. The fake mirrors the observable effect: the callback receives
    // a transaction client that shares the read view but isolates its writes;
    // on commit the writes are merged into the persistent store, on rejection
    // they are discarded.
    //
    // The transaction client the proxy returns inside `$transaction` is the
    // ambient client with a flag attached — it exposes the same jest.fn
    // methods as the ambient client, so any `mockRejectedValue` a test sets
    // on `prisma.client.agentRoleEntry.createMany` is in effect for both
    // the ambient client and the transaction client.
    (ambientClient.$transaction as jest.Mock).mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) => {
        const txClient = Object.assign(Object.create(ambientClient), { __isTxClient: true });
        const txAgentsBefore = txRows.agents.length;
        const txRoleEntriesBefore = txRows.roleEntries.length;
        const txCapabilityEntriesBefore = txRows.capabilityEntries.length;
        try {
          // The real `PrismaTransactionManager` calls `als.run(tx, fn)` to
          // install the transaction client in the AsyncLocalStorage so the
          // proxy can find it. We replicate exactly that.
          const result = await als.run(txClient, async () => callback(txClient));
          // Commit: flush the per-transaction writes into the persistent store.
          agents.push(...txRows.agents.splice(txAgentsBefore));
          roleEntries.push(...txRows.roleEntries.splice(txRoleEntriesBefore));
          capabilityEntries.push(
            ...txRows.capabilityEntries.splice(txCapabilityEntriesBefore),
          );
          return result;
        } catch (error) {
          // Rollback: discard every write made during this transaction.
          txRows.agents.splice(txAgentsBefore);
          txRows.roleEntries.splice(txRoleEntriesBefore);
          txRows.capabilityEntries.splice(txCapabilityEntriesBefore);
          throw error;
        }
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

  it('AC7: leaves no agent row behind when the roles/capabilities write fails', async () => {
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

    // The row was written before the failure — otherwise this test proves nothing.
    expect(prisma.client.agent.create).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(500);
    expect(agents.filter((agent) => agent.slug === 'rollback-agent')).toHaveLength(0);
  });

  it('AC7 boundary: a failing roles/capabilities write rolls back the role rows too', async () => {
    (prisma.client.agentCapabilityEntry.createMany as jest.Mock).mockRejectedValue(
      new Error('agentCapabilityEntry insert failed'),
    );

    await request(app.getHttpServer())
      .post('/api/agents')
      .send({ name: 'Rollback Agent', slug: 'rollback-agent', roles: ['DEVELOPER'] });

    expect(agents).toHaveLength(0);
    expect(roleEntries).toHaveLength(0);
    expect(capabilityEntries).toHaveLength(0);
  });
});
