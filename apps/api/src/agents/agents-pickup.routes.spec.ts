import type { Mock } from 'vitest';
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
import { AUTH_CFG, IAuthConfig } from '../config/auth.config';
import { MembershipService } from '../permissions/membership.service';
import { PermissionService } from '../permissions/permission.service';
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
    findBySlugWithCapabilities: Mock;
    findProjectBySlug: Mock;
    findVerifiedUnassignedTickets: Mock;
    findBySlug: Mock;
    findById: Mock;
    isOnProjectRoster: Mock;
  };

  /**
   * Permissions P1 (US-009): the pickup target's project keys are the authorization. The double
   * answers `agent.pickup` by default — every AC here except the two refusal rows starts from a
   * target that holds it.
   *
   * Permissions P1 (US-002): `can` answers `agent.update` for a caller that is not the owning agent,
   * so it allows by default and the refusal rows below turn it off.
   */
  const permissions: { can: Mock; effectiveKeys: Mock } = {
    can: vi.fn(async () => ({ allowed: true, reason: 'granted' })),
    effectiveKeys: vi.fn(async () => new Set<string>(['agent.pickup'])),
  };

  const DEFAULT_AUTH_CONFIG: Omit<IAuthConfig, 'agentProjectScoping'> = {
    jwtSecret: 'jwt-secret',
    jwtExpiresIn: '15m',
    jwtRefreshSecret: 'jwt-refresh-secret',
    jwtRefreshExpiresIn: '7d',
    apiKeySecret: 'test-secret',
    registrationEnabled: false,
  };

  /** Boots the real controller + service against the stubbed repository. */
  async function bootApp(authConfig: Partial<IAuthConfig> = {}): Promise<void> {
    testingModule = await Test.createTestingModule({
      controllers: [AgentsController],
      providers: [
        AgentsService,
        { provide: PrismaAgentRepository, useValue: agentRepo },
        {
          provide: AUTH_CFG,
          useValue: { ...DEFAULT_AUTH_CONFIG, ...authConfig },
        },
        {
          provide: TRANSACTION_MANAGER,
          useValue: {
            run: vi.fn((fn: () => Promise<unknown>) => fn()),
            getClient: vi.fn(),
            isInTransaction: vi.fn(() => false),
          },
        },
        // Permissions P1a (US-004): AgentsService injects the permissions module's MembershipService.
        {
          provide: MembershipService,
          useValue: {
            bindBaseline: vi.fn(),
            removeAllBindings: vi.fn(),
            // B3: the baseline write joins the create transaction; the stub runs the callback as-is.
            afterCommit: vi.fn((fn: () => Promise<unknown>) => fn()),
          },
        },
        // Permissions P1 (US-009): the service's required fifth dependency, and the guard's.
        { provide: PermissionService, useValue: permissions },
        {
          provide: KodaDomainWriter,
          useValue: { writeAgentAction: vi.fn().mockResolvedValue({ canonicalId: 'evt-1' }) },
        },
        {
          provide: AgentAuthProvider,
          useValue: { invalidateByTag: vi.fn().mockResolvedValue(undefined) },
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
  }

  /** The preconditions every pickup test starts from: a project with two candidates. */
  function seedHappyPath(): void {
    agentRepo.findBySlugWithCapabilities.mockResolvedValue(AGENT_ROW);
    agentRepo.findProjectBySlug.mockResolvedValue(PROJECT);
    // Permissions P1 (US-009): the target agent holds `agent.pickup` in the project unless a test
    // says otherwise. The roster row is read by the permission union, not by the pickup path.
    permissions.effectiveKeys.mockResolvedValue(new Set<string>(['agent.pickup']));
    agentRepo.findVerifiedUnassignedTickets.mockResolvedValue([
      makeTicket('ticket-1', 1, 'HIGH', ['typescript']),
      makeTicket('ticket-2', 2, 'CRITICAL', []),
    ]);
  }

  beforeEach(async () => {
    agentRepo = {
      findBySlugWithCapabilities: vi.fn(),
      findProjectBySlug: vi.fn(),
      findVerifiedUnassignedTickets: vi.fn(),
      findBySlug: vi.fn(),
      findById: vi.fn(),
      isOnProjectRoster: vi.fn(),
    };

    await bootApp();
    currentPrincipal = agentPrincipal('test-agent');
    // Permissions P1 (US-002): `can` decides acting for another agent, so it starts from the seeded
    // Owner/Admin answer and each refusal row below turns it off.
    permissions.can.mockReset().mockResolvedValue({ allowed: true, reason: 'granted' });
    seedHappyPath();
  });

  afterEach(async () => {
    if (app) await app.close();
    vi.clearAllMocks();
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
    // Permissions P1 (US-002): another agent is admitted only with `agent.update`, which it lacks.
    permissions.can.mockResolvedValue({ allowed: false, reason: 'not-granted' });
    currentPrincipal = agentPrincipal('other-agent');

    const res = await request(app.getHttpServer())
      .get('/api/agents/test-agent/pickup')
      .query({ project: 'koda' });

    expect(res.status).toBe(403);
    expect(permissions.can).toHaveBeenCalledWith(currentPrincipal, 'agent.update');
    // No target-agent key read and no ticket read.
    expect(permissions.effectiveKeys).not.toHaveBeenCalled();
    expect(agentRepo.findVerifiedUnassignedTickets).not.toHaveBeenCalled();
  });

  it('AC11: returns 403 for a user without agent.update', async () => {
    permissions.can.mockResolvedValue({ allowed: false, reason: 'not-granted' });
    currentPrincipal = userPrincipal('MEMBER');

    const res = await request(app.getHttpServer())
      .get('/api/agents/test-agent/pickup')
      .query({ project: 'koda' });

    expect(res.status).toBe(403);
    expect(permissions.can).toHaveBeenCalledWith(currentPrincipal, 'agent.update');
    expect(permissions.effectiveKeys).not.toHaveBeenCalled();
    expect(agentRepo.findVerifiedUnassignedTickets).not.toHaveBeenCalled();
  });

  it('AC12: returns 200 for a user holding agent.update', async () => {
    currentPrincipal = userPrincipal('ADMIN');

    const res = await request(app.getHttpServer())
      .get('/api/agents/test-agent/pickup')
      .query({ project: 'koda' });

    expect(res.status).toBe(200);
    expect(permissions.can).toHaveBeenCalledWith(currentPrincipal, 'agent.update');
    expect(res.body.data.ticket.ref).toBe('KT-1');
    expect(res.body.data.matchScore).toBe(1);
  });

  it('US-009: returns 403 permissions when the target agent holds no agent.pickup in the project', async () => {
    permissions.effectiveKeys.mockResolvedValue(new Set<string>());
    currentPrincipal = userPrincipal('ADMIN');

    const res = await request(app.getHttpServer())
      .get('/api/agents/test-agent/pickup')
      .query({ project: 'koda' });

    expect(res.status).toBe(403);
    // The target's keys, in the project's scope — not the caller's.
    expect(permissions.effectiveKeys).toHaveBeenCalledWith(
      { type: 'AGENT', id: 'agent-123' },
      { projectId: 'project-1' },
    );
    expect(agentRepo.isOnProjectRoster).not.toHaveBeenCalled();
    expect(agentRepo.findVerifiedUnassignedTickets).not.toHaveBeenCalled();
  });

  it('US-009: admits the target agent when it holds agent.pickup, and never reads the roster directly', async () => {
    currentPrincipal = userPrincipal('ADMIN');

    const res = await request(app.getHttpServer())
      .get('/api/agents/test-agent/pickup')
      .query({ project: 'koda' });

    expect(res.status).toBe(200);
    expect(res.body.data.ticket.ref).toBe('KT-1');
    expect(permissions.effectiveKeys).toHaveBeenCalledTimes(1);
    expect(agentRepo.isOnProjectRoster).not.toHaveBeenCalled();
  });

  it('US-009: still asks the target agent keys when agent project scoping is off', async () => {
    await app.close();
    await bootApp({ agentProjectScoping: false });
    seedHappyPath();
    permissions.effectiveKeys.mockResolvedValue(new Set<string>());
    currentPrincipal = userPrincipal('ADMIN');

    const res = await request(app.getHttpServer())
      .get('/api/agents/test-agent/pickup')
      .query({ project: 'koda' });

    expect(res.status).toBe(403);
    // Scoping off changes what the rows grant, not whether the key is asked for.
    expect(permissions.effectiveKeys).toHaveBeenCalledWith(
      { type: 'AGENT', id: 'agent-123' },
      { projectId: 'project-1' },
    );
    expect(agentRepo.isOnProjectRoster).not.toHaveBeenCalled();
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
