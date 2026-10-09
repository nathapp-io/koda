/**
 * US-003 — GET /api/agents/:slug/pickup authorization, over a real Fastify HTTP
 * server. The controller and AgentsService are real; only the repository is
 * stubbed, because the pickup permission rule (self agent or global ADMIN) lives
 * in the service. No database, no network.
 */
import { CanActivate, ExecutionContext } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import request from 'supertest';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { PrismaAgentRepository } from './prisma-agent.repository';
import { AUTH_CFG } from '../config/auth.config';
import { KodaDomainWriter } from '../koda-domain-writer/koda-domain-writer.service';
import { AgentAuthProvider } from '../auth/agent-auth.provider';
import {
  AgentPrincipal,
  KodaPrincipal,
  UserPrincipal,
} from '../auth/principal/koda-principal.types';

const PROJECT = { id: 'project-1', slug: 'koda', key: 'KT', deletedAt: null as Date | null };

const AGENT_ROW = {
  id: 'agent-123',
  slug: 'test-agent',
  capabilities: [{ id: 'cap-1', agentId: 'agent-123', capability: 'typescript' }],
};

function makeTicket(id: string, number: number, priority: string, labelNames: string[]) {
  return {
    id,
    projectId: PROJECT.id,
    number,
    type: 'BUG',
    title: `Ticket ${number}`,
    description: null,
    status: 'VERIFIED',
    priority,
    assignedToUserId: null,
    assignedToAgentId: null,
    createdByUserId: 'user-admin',
    createdByAgentId: null,
    gitRefVersion: null,
    gitRefFile: null,
    gitRefLine: null,
    gitRefUrl: null,
    createdAt: new Date('2026-09-27T00:00:00.000Z'),
    updatedAt: new Date('2026-09-27T00:00:00.000Z'),
    deletedAt: null,
    links: [],
    labels: labelNames.map((name, index) => ({
      id: `ticket-label-${index}`,
      ticketId: id,
      labelId: `label-${index}`,
      label: { id: `label-${index}`, projectId: PROJECT.id, name, color: null },
    })),
  };
}

function agentPrincipal(slug: string): AgentPrincipal {
  return {
    actorType: 'agent',
    id: 'agent-123',
    name: slug,
    slug,
    status: 'ACTIVE',
    agentRoles: ['DEVELOPER'],
    capabilities: [],
    blacklisted: false,
    revoked: false,
    authorities: ['WORKER'],
  };
}

function userPrincipal(role: 'ADMIN' | 'MEMBER'): UserPrincipal {
  return {
    actorType: 'user',
    id: `user-${role.toLowerCase()}`,
    name: `${role.toLowerCase()}@koda.dev`,
    email: `${role.toLowerCase()}@koda.dev`,
    role,
    blacklisted: false,
    revoked: false,
    authorities: [role],
    extra: {},
  };
}

describe('GET /api/agents/:slug/pickup (US-003)', () => {
  let testingModule: TestingModule;
  let app: NestFastifyApplication;
  let currentPrincipal: KodaPrincipal;

  let agentRepo: {
    findBySlugWithCapabilities: jest.Mock;
    findProjectBySlug: jest.Mock;
    findVerifiedUnassignedTickets: jest.Mock;
    findBySlug: jest.Mock;
    findById: jest.Mock;
    isOnProjectRoster: jest.Mock;
  };

  beforeEach(async () => {
    agentRepo = {
      findBySlugWithCapabilities: jest.fn(),
      findProjectBySlug: jest.fn(),
      findVerifiedUnassignedTickets: jest.fn(),
      findBySlug: jest.fn(),
      findById: jest.fn(),
      isOnProjectRoster: jest.fn(),
    };

    testingModule = await Test.createTestingModule({
      controllers: [AgentsController],
      providers: [
        AgentsService,
        { provide: PrismaAgentRepository, useValue: agentRepo },
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
          provide: TRANSACTION_MANAGER,
          useValue: {
            run: jest.fn((fn: () => Promise<unknown>) => fn()),
            getClient: jest.fn(),
            isInTransaction: jest.fn(() => false),
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

    const principalInjector: CanActivate = {
      canActivate: (ctx: ExecutionContext) => {
        ctx.switchToHttp().getRequest<{ user?: KodaPrincipal }>().user = currentPrincipal;
        return true;
      },
    };
    app.useGlobalGuards(principalInjector);

    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    currentPrincipal = agentPrincipal('test-agent');

    agentRepo.findBySlugWithCapabilities.mockResolvedValue(AGENT_ROW);
    agentRepo.findProjectBySlug.mockResolvedValue(PROJECT);
    // S4c US-001: the target agent is on the project roster unless a test says otherwise.
    agentRepo.isOnProjectRoster.mockResolvedValue(true);
    agentRepo.findVerifiedUnassignedTickets.mockResolvedValue([
      makeTicket('ticket-1', 1, 'HIGH', ['typescript']),
      makeTicket('ticket-2', 2, 'CRITICAL', []),
    ]);
  });

  afterEach(async () => {
    if (app) await app.close();
    jest.clearAllMocks();
  });

  it('AC9: returns 200 when authenticated as that agent', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/agents/test-agent/pickup')
      .query({ project: 'koda' });

    expect(res.status).toBe(200);
    expect(res.body.data).not.toBeNull();
  });

  it('AC9: preserves capability ranking for the authorized agent', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/agents/test-agent/pickup')
      .query({ project: 'koda' });

    expect(res.body.data.ticket.ref).toBe('KT-1');
    expect(res.body.data.matchScore).toBe(1);
    expect(res.body.data.matchedCapabilities).toEqual(['typescript']);
  });

  it('AC9 boundary: returns 200 with null data when the project has no VERIFIED tickets', async () => {
    agentRepo.findVerifiedUnassignedTickets.mockResolvedValue([]);

    const res = await request(app.getHttpServer())
      .get('/api/agents/test-agent/pickup')
      .query({ project: 'koda' });

    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });

  it('AC10: returns 403 when authenticated as a different agent', async () => {
    currentPrincipal = agentPrincipal('other-agent');

    const res = await request(app.getHttpServer())
      .get('/api/agents/test-agent/pickup')
      .query({ project: 'koda' });

    expect(res.status).toBe(403);
    expect(agentRepo.findVerifiedUnassignedTickets).not.toHaveBeenCalled();
  });

  it('AC11: returns 403 for a non-ADMIN user', async () => {
    currentPrincipal = userPrincipal('MEMBER');

    const res = await request(app.getHttpServer())
      .get('/api/agents/test-agent/pickup')
      .query({ project: 'koda' });

    expect(res.status).toBe(403);
    expect(agentRepo.findVerifiedUnassignedTickets).not.toHaveBeenCalled();
  });

  it('AC12: returns 200 for a global ADMIN user', async () => {
    currentPrincipal = userPrincipal('ADMIN');

    const res = await request(app.getHttpServer())
      .get('/api/agents/test-agent/pickup')
      .query({ project: 'koda' });

    expect(res.status).toBe(200);
    expect(res.body.data.ticket.ref).toBe('KT-1');
    expect(res.body.data.matchScore).toBe(1);
  });

  it('AC12 boundary (S4c US-001): returns 403 when the target agent is not on the project roster', async () => {
    agentRepo.isOnProjectRoster.mockResolvedValue(false);
    currentPrincipal = userPrincipal('ADMIN');

    const res = await request(app.getHttpServer())
      .get('/api/agents/test-agent/pickup')
      .query({ project: 'koda' });

    expect(res.status).toBe(403);
    expect(agentRepo.isOnProjectRoster).toHaveBeenCalledWith('agent-123', 'project-1');
    expect(agentRepo.findVerifiedUnassignedTickets).not.toHaveBeenCalled();
  });

  it('AC13: returns 404 when the project is soft-deleted', async () => {
    agentRepo.findProjectBySlug.mockResolvedValue({ ...PROJECT, deletedAt: new Date() });

    const res = await request(app.getHttpServer())
      .get('/api/agents/test-agent/pickup')
      .query({ project: 'koda' });

    expect(res.status).toBe(404);
    expect(agentRepo.findVerifiedUnassignedTickets).not.toHaveBeenCalled();
  });

  it('AC14: returns 404 when the project is missing', async () => {
    agentRepo.findProjectBySlug.mockResolvedValue(null);

    const res = await request(app.getHttpServer())
      .get('/api/agents/test-agent/pickup')
      .query({ project: 'ghost-project' });

    expect(res.status).toBe(404);
    expect(agentRepo.findVerifiedUnassignedTickets).not.toHaveBeenCalled();
  });
});
