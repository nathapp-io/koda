/**
 * US-003 — POST /api/agents over a real Fastify HTTP server.
 *
 * The controller, AgentsService and PrismaAgentRepository are the real ones; only
 * the database is fake: `PrismaService.client` is an in-memory store that mirrors
 * the Prisma schema defaults (Agent.status defaults to 'ACTIVE') and raises a
 * Prisma P2002 error on a duplicate slug, and the injected TRANSACTION_MANAGER
 * snapshots the store so a failing transaction rolls the writes back.
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
  let nextAgentId: number;
  let currentPrincipal: KodaPrincipal;

  beforeEach(async () => {
    agents = [];
    roleEntries = [];
    capabilityEntries = [];
    nextAgentId = 0;

    prisma = createMockPrismaService();

    prisma.client.agent = {
      create: jest.fn(async ({ data }: { data: Partial<AgentRow> }) => {
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
      }),
      findUnique: jest.fn(
        async ({ where }: { where: { slug?: string; id?: string } }) =>
          agents.find((agent) =>
            where.slug !== undefined ? agent.slug === where.slug : agent.id === where.id,
          ) ?? null,
      ),
      findMany: jest.fn(async () => agents),
      update: jest.fn(async () => agents[0]),
    };

    prisma.client.agentRoleEntry = {
      createMany: jest.fn(async ({ data }: { data: EntryRow[] }) => {
        roleEntries.push(...data);
        return { count: data.length };
      }),
    };

    prisma.client.agentCapabilityEntry = {
      createMany: jest.fn(async ({ data }: { data: EntryRow[] }) => {
        capabilityEntries.push(...data);
        return { count: data.length };
      }),
    };

    // Prisma's array form: settle the promises so a rejected write is handled
    // here instead of becoming an unhandled rejection.
    (prisma.client.$transaction as jest.Mock).mockImplementation(async (arg: unknown) =>
      Array.isArray(arg) ? Promise.all(arg) : (arg as () => Promise<unknown>)(),
    );

    // Stands in for the production transaction manager: the writes happen inside
    // `run`, and a rejection inside the callback rolls the store back.
    const txManager = {
      run: jest.fn(async (fn: () => Promise<unknown>) => {
        const snapshot = {
          agents: [...agents],
          roleEntries: [...roleEntries],
          capabilityEntries: [...capabilityEntries],
        };

        try {
          return await fn();
        } catch (error) {
          agents = snapshot.agents;
          roleEntries = snapshot.roleEntries;
          capabilityEntries = snapshot.capabilityEntries;
          throw error;
        }
      }),
      getClient: jest.fn(),
      isInTransaction: jest.fn(() => false),
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
