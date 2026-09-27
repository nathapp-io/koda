/**
 * US-003 — POST /api/agents over a real Fastify HTTP server.
 *
 * The controller, AgentsService and PrismaAgentRepository are the real ones; only
 * the database is fake. The fake `PrismaService.client` mirrors the Prisma schema
 * defaults (Agent.status defaults to 'ACTIVE') and raises a Prisma P2002 error
 * on a duplicate slug. The injected TRANSACTION_MANAGER mimics the production
 * `PrismaTransactionManager`: it calls `prisma.$transaction(fn)`, and inside the
 * callback every write targets a per-transaction buffer that is only flushed to
 * the ambient store when the callback resolves. A rejection inside the callback
 * discards the buffer — exactly how the production `$transaction` rolls back.
 * Writes outside a transaction land directly in the ambient store.
 *
 * No database, no network: everything runs in-process.
 */
import { CanActivate, ExecutionContext } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Prisma } from '@prisma/client';
import { PrismaService, createMockPrismaService } from '@nathapp/nestjs-prisma';
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

  let agents: AgentRow[];
  let roleEntries: EntryRow[];
  let capabilityEntries: EntryRow[];
  // Per-transaction buffers. While inside `txManager.run` the mocked prisma
  // client writes here, NOT to the ambient arrays above; on commit the buffer
  // is flushed to the ambient arrays, on rollback it is discarded.
  let txAgents: AgentRow[];
  let txRoleEntries: EntryRow[];
  let txCapabilityEntries: EntryRow[];
  let nextAgentId: number;
  let currentPrincipal: KodaPrincipal;
  // Mirrors the AsyncLocalStorage branch in the production `PrismaTransactionManager`:
  // while `inTransaction === true`, the proxy on `prismaService.client` (which
  // we mimic here on the prisma mocks) returns the per-transaction client.
  let txState: { inTransaction: boolean };

  beforeEach(async () => {
    agents = [];
    roleEntries = [];
    capabilityEntries = [];
    txAgents = [];
    txRoleEntries = [];
    txCapabilityEntries = [];
    nextAgentId = 0;
    txState = { inTransaction: false };

    prisma = createMockPrismaService();

    prisma.client.agent = {
      create: jest.fn(async ({ data }: { data: Partial<AgentRow> }) => {
        // Inside a transaction the proxy returns the transaction client, which
        // sees both the already-committed rows (the ambient store) and the
        // pending rows in the per-transaction buffer.
        const visibleAgents = txState.inTransaction ? [...txAgents, ...agents] : agents;
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

        // The production code reads `prismaService.client`, which is a Proxy
        // that returns the transaction client while inside `txManager.run`.
        // Writes through that transaction client would be undone by
        // `prisma.$transaction` rolling back. We mirror that here: writes
        // during a transaction land in the per-transaction buffer and only
        // reach the ambient store when the transaction commits.
        if (txState.inTransaction) {
          txAgents.push(row);
        } else {
          agents.push(row);
        }
        return row;
      }),
      findUnique: jest.fn(
        async ({ where }: { where: { slug?: string; id?: string } }) => {
          const visibleAgents = txState.inTransaction ? [...txAgents, ...agents] : agents;
          return (
            visibleAgents.find((agent) =>
              where.slug !== undefined ? agent.slug === where.slug : agent.id === where.id,
            ) ?? null
          );
        },
      ),
      findMany: jest.fn(async () => (txState.inTransaction ? [...txAgents, ...agents] : agents)),
      update: jest.fn(async () => agents[0]),
    };

    prisma.client.agentRoleEntry = {
      createMany: jest.fn(async ({ data }: { data: EntryRow[] }) => {
        if (txState.inTransaction) {
          txRoleEntries.push(...data);
        } else {
          roleEntries.push(...data);
        }
        return { count: data.length };
      }),
    };

    prisma.client.agentCapabilityEntry = {
      createMany: jest.fn(async ({ data }: { data: EntryRow[] }) => {
        if (txState.inTransaction) {
          txCapabilityEntries.push(...data);
        } else {
          capabilityEntries.push(...data);
        }
        return { count: data.length };
      }),
    };

    // The production `$transaction(async (tx) => { ... })` is what the
    // `PrismaTransactionManager` calls. We simulate its rollback semantics:
    // if the callback throws, every write the callback did is undone; on
    // success the writes are applied to the ambient store.
    (prisma.client.$transaction as jest.Mock).mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) => {
        const wasInTransaction = txState.inTransaction;
        txState.inTransaction = true;
        const txAgentsBefore = txAgents.length;
        const txRoleEntriesBefore = txRoleEntries.length;
        const txCapabilityEntriesBefore = txCapabilityEntries.length;

        try {
          const result = await callback(prisma.client);
          // Commit: flush the per-transaction buffers to the ambient store.
          agents.push(...txAgents);
          roleEntries.push(...txRoleEntries);
          capabilityEntries.push(...txCapabilityEntries);
          txAgents = [];
          txRoleEntries = [];
          txCapabilityEntries = [];
          return result;
        } catch (error) {
          // Rollback: drop everything written during this transaction.
          txAgents = txAgents.slice(0, txAgentsBefore);
          txRoleEntries = txRoleEntries.slice(0, txRoleEntriesBefore);
          txCapabilityEntries = txCapabilityEntries.slice(0, txCapabilityEntriesBefore);
          throw error;
        } finally {
          txState.inTransaction = wasInTransaction;
        }
      },
    );

    // The injected TRANSACTION_MANAGER. Its `run` is what the production code
    // uses to wrap the agent-row + roles/capabilities writes. To mirror the
    // real `PrismaTransactionManager.run`, our mock routes through
    // `prisma.$transaction` instead of doing its own snapshot-and-restore —
    // otherwise the test would assume the very rollback behaviour it is meant
    // to verify.
    const txManager = {
      run: jest.fn(async (fn: () => Promise<unknown>) => {
        // Nested `run` calls reuse the active transaction, exactly like the
        // production manager. We model that by skipping a second $transaction
        // when we are already inside one.
        if (txState.inTransaction) {
          return fn();
        }
        return (prisma.client.$transaction as jest.Mock)(async () => fn());
      }),
      getClient: jest.fn(() => prisma.client),
      isInTransaction: jest.fn(() => txState.inTransaction),
    };

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
