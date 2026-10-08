/**
 * US-005 — AC3: POST /api/agents with a valid body still returns 201 after the
 * service-local `CreateAgentDto` / `UpdateAgentDto` classes are deleted and the
 * controller imports the canonical DTOs from `agents/dto/*`.
 *
 * Boots a real Fastify HTTP server with the production validation pipe settings
 * (`useAppGlobalPipes`: `forbidUnknownValues: false, stopAtFirstError: true, whitelist: true`) and
 * the real AgentsService over a stubbed repository. No database, no network.
 */
import { CanActivate, ExecutionContext, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import request from 'supertest';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { PrismaAgentRepository } from './prisma-agent.repository';
import { AUTH_CFG, IAuthConfig } from '../config/auth.config';
import { KodaDomainWriter } from '../koda-domain-writer/koda-domain-writer.service';
import { AgentAuthProvider } from '../auth/agent-auth.provider';
import { KodaPrincipal } from '../auth/principal/koda-principal.types';

interface AgentRepositoryStub {
  create: jest.Mock;
  createRolesAndCapabilities: jest.Mock;
}

interface TxManagerStub {
  run: jest.Mock;
  getClient: jest.Mock;
  isInTransaction: jest.Mock;
}

const authConfig: IAuthConfig = {
  jwtSecret: 'jwt-secret',
  jwtExpiresIn: '15m',
  jwtRefreshSecret: 'jwt-refresh-secret',
  jwtRefreshExpiresIn: '7d',
  apiKeySecret: 'test-secret',
  registrationEnabled: false,
};

describe('POST /api/agents with the canonical CreateAgentDto (US-005 AC3)', () => {
  let testingModule: TestingModule;
  let app: NestFastifyApplication;

  let agentRepo: AgentRepositoryStub;
  let txManager: TxManagerStub;

  const adminUser: KodaPrincipal = {
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

  beforeAll(async () => {
    agentRepo = {
      create: jest.fn(),
      createRolesAndCapabilities: jest.fn().mockResolvedValue(undefined),
    };
    txManager = {
      run: jest.fn((fn: () => Promise<unknown>) => fn()),
      getClient: jest.fn(),
      isInTransaction: jest.fn(() => false),
    };

    testingModule = await Test.createTestingModule({
      controllers: [AgentsController],
      providers: [
        AgentsService,
        { provide: PrismaAgentRepository, useValue: agentRepo },
        { provide: TRANSACTION_MANAGER, useValue: txManager },
        { provide: AUTH_CFG, useValue: authConfig },
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
    const principalInjector: CanActivate = {
      canActivate: (ctx: ExecutionContext) => {
        ctx.switchToHttp().getRequest<{ user?: KodaPrincipal }>().user = adminUser;
        return true;
      },
    };
    app.useGlobalGuards(principalInjector);
    // Mirrors AppFactory.useAppGlobalPipes() — the pipe the route is validated
    // against in production.
    app.useGlobalPipes(new ValidationPipe({ forbidUnknownValues: false, stopAtFirstError: true, whitelist: true }));

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    txManager.run.mockImplementation((fn: () => Promise<unknown>) => fn());
    agentRepo.createRolesAndCapabilities.mockResolvedValue(undefined);
  });

  it('AC3: POST /api/agents with a valid body returns 201 and creates the agent', async () => {
    agentRepo.create.mockImplementation(async (data: { name: string; slug: string }) => ({
      id: 'agent-1',
      name: data.name,
      slug: data.slug,
      apiKeyHash: 'hash',
      status: 'ACTIVE',
      maxConcurrentTickets: 3,
      createdAt: new Date('2026-09-27T00:00:00.000Z'),
      updatedAt: new Date('2026-09-27T00:00:00.000Z'),
    }));

    const res = await request(app.getHttpServer())
      .post('/api/agents')
      .send({ name: 'Subrina Coder', slug: 'good-slug-1' });

    expect(res.status).toBe(201);
    expect(agentRepo.create).toHaveBeenCalledTimes(1);
    expect(agentRepo.create.mock.calls[0][0]).toEqual(
      expect.objectContaining({ name: 'Subrina Coder', slug: 'good-slug-1' }),
    );
    expect(res.body.data.agent.slug).toBe('good-slug-1');
    expect(res.body.data.apiKey).toMatch(/^[a-f0-9]{64}$/);
  });

  it('AC3 boundary: a body without a slug is rejected with 400 by the canonical CreateAgentDto', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/agents')
      .send({ name: 'Subrina Coder' });

    expect(res.status).toBe(400);
    expect(agentRepo.create).not.toHaveBeenCalled();
  });

  it('AC3 boundary: a body with an invalid slug is rejected with 400 and never reaches the service', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/agents')
      .send({ name: 'Subrina Coder', slug: 'Bad Slug!' });

    expect(res.status).toBe(400);
    expect(agentRepo.create).not.toHaveBeenCalled();
  });
});
