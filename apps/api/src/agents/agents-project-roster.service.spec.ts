/**
 * S4c US-003 — the roster write rules live in AgentsService: who may be added
 * (existing, not OFFLINE, not already rostered) and when a removal is refused
 * (open tickets), with the read-then-write serialized by the project's roster
 * lock. Authorization stays at the controller/guard boundary, so these cases
 * exercise the service directly with a mocked repository.
 */
import { ConflictAppException } from '../common/exceptions/conflict-app.exception';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { AgentsService } from './agents.service';
import { PrismaAgentRepository } from './prisma-agent.repository';
import { IAuthConfig } from '../config/auth.config';
import type { ProjectAgentRecord } from './dto/project-agent.dto';

const record = (over: Partial<ProjectAgentRecord> = {}): ProjectAgentRecord => ({
  slug: 'bot',
  name: 'Bot',
  status: 'ACTIVE',
  roles: ['DEVELOPER'],
  capabilities: ['typescript'],
  openTicketCount: 0,
  openTicketRefs: [],
  addedAt: new Date('2026-10-01T00:00:00.000Z'),
  addedById: 'user-admin',
  addedByName: 'Admin',
  ...over,
});

describe('AgentsService project roster writes (S4c US-003)', () => {
  let repo: Record<string, jest.Mock>;
  let txManager: { run: jest.Mock; isInTransaction: jest.Mock };
  let service: AgentsService;

  const authConfig: IAuthConfig = { apiKeySecret: 'test-secret', agentProjectScoping: true } as IAuthConfig;
  const project = { id: 'proj-1', slug: 'alpha', deletedAt: null };

  beforeEach(() => {
    repo = {
      findProjectBySlug: jest.fn(),
      findBySlugScalar: jest.fn(),
      findProjectRoster: jest.fn(),
      addToProjectRoster: jest.fn(),
      countOpenProjectTickets: jest.fn(),
      removeFromProjectRoster: jest.fn(),
      lockProjectAgents: jest.fn(),
      isOnProjectRoster: jest.fn(),
    };
    txManager = { run: jest.fn((fn: () => Promise<unknown>) => fn()), isInTransaction: jest.fn(() => false) };
    service = new AgentsService(
      repo as unknown as PrismaAgentRepository,
      authConfig,
      txManager as never,
    );
  });

  describe('addToProject', () => {
    it('roster the agent and returns the roster row the list would serve', async () => {
      repo.findProjectBySlug.mockResolvedValue(project);
      repo.findBySlugScalar.mockResolvedValue({ id: 'agent-1', slug: 'bot', status: 'ACTIVE' });
      repo.addToProjectRoster.mockResolvedValue('created');
      repo.findProjectRoster.mockResolvedValue([record()]);

      const dto = await service.addToProject('alpha', 'bot', 'user-admin');

      expect(repo.addToProjectRoster).toHaveBeenCalledWith('agent-1', 'proj-1', 'user-admin');
      expect(dto).toMatchObject({
        slug: 'bot',
        status: 'ACTIVE',
        roles: ['DEVELOPER'],
        capabilities: ['typescript'],
        openTicketCount: 0,
        addedBy: { id: 'user-admin', name: 'Admin' },
      });
      expect(dto.addedAt).toBe('2026-10-01T00:00:00.000Z');
    });

    it('404s a missing or soft-deleted project before touching the roster', async () => {
      repo.findProjectBySlug.mockResolvedValue({ ...project, deletedAt: new Date() });

      await expect(service.addToProject('alpha', 'bot', 'user-admin')).rejects.toBeInstanceOf(NotFoundAppException);
      expect(repo.addToProjectRoster).not.toHaveBeenCalled();
    });

    it('404s an unknown agent slug', async () => {
      repo.findProjectBySlug.mockResolvedValue(project);
      repo.findBySlugScalar.mockResolvedValue(null);

      await expect(service.addToProject('alpha', 'ghost', 'user-admin')).rejects.toBeInstanceOf(NotFoundAppException);
      expect(repo.addToProjectRoster).not.toHaveBeenCalled();
    });

    it('409s an OFFLINE agent and stores nothing', async () => {
      repo.findProjectBySlug.mockResolvedValue(project);
      repo.findBySlugScalar.mockResolvedValue({ id: 'agent-1', slug: 'bot', status: 'OFFLINE' });

      const error = await service.addToProject('alpha', 'bot', 'user-admin').catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ConflictAppException);
      expect((error as ConflictAppException).prefix).toBe('projectAgents.agentOffline');
      expect(repo.addToProjectRoster).not.toHaveBeenCalled();
    });

    it('409s an already rostered agent (the composite-key conflict)', async () => {
      repo.findProjectBySlug.mockResolvedValue(project);
      repo.findBySlugScalar.mockResolvedValue({ id: 'agent-1', slug: 'bot', status: 'ACTIVE' });
      repo.addToProjectRoster.mockResolvedValue('alreadyAssigned');

      const error = await service.addToProject('alpha', 'bot', 'user-admin').catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ConflictAppException);
      expect((error as ConflictAppException).prefix).toBe('projectAgents.alreadyAssigned');
    });
  });

  describe('removeFromProject', () => {
    const rostered = { id: 'agent-1', slug: 'bot' };

    beforeEach(() => {
      repo.findProjectBySlug.mockResolvedValue(project);
      repo.findBySlugScalar.mockResolvedValue(rostered);
      repo.isOnProjectRoster.mockResolvedValue(true);
      repo.countOpenProjectTickets.mockResolvedValue({ count: 0, refs: [] });
    });

    it('removes the roster row under the project lock', async () => {
      await service.removeFromProject('alpha', 'bot');

      expect(repo.lockProjectAgents).toHaveBeenCalledWith('proj-1');
      expect(repo.countOpenProjectTickets).toHaveBeenCalledWith('agent-1', 'proj-1');
      expect(repo.removeFromProjectRoster).toHaveBeenCalledWith('agent-1', 'proj-1');
      expect(repo.lockProjectAgents.mock.invocationCallOrder[0])
        .toBeLessThan(repo.removeFromProjectRoster.mock.invocationCallOrder[0]);
    });

    it('409s while the agent holds open tickets, reporting the count and their refs', async () => {
      repo.countOpenProjectTickets.mockResolvedValue({ count: 2, refs: ['ALP-1', 'ALP-2'] });

      const error = await service.removeFromProject('alpha', 'bot').catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ConflictAppException);
      expect((error as ConflictAppException).prefix).toBe('projectAgents.hasOpenTickets');
      expect((error as ConflictAppException).args).toEqual({ count: 2, refs: 'ALP-1, ALP-2' });
      expect(repo.removeFromProjectRoster).not.toHaveBeenCalled();
    });

    it('404s an agent that is not on the roster, without counting tickets', async () => {
      repo.isOnProjectRoster.mockResolvedValue(false);

      await expect(service.removeFromProject('alpha', 'bot')).rejects.toBeInstanceOf(NotFoundAppException);
      expect(repo.countOpenProjectTickets).not.toHaveBeenCalled();
      expect(repo.removeFromProjectRoster).not.toHaveBeenCalled();
    });

    it('404s an unknown agent slug before opening a transaction', async () => {
      repo.findProjectBySlug.mockResolvedValue(project);
      repo.findBySlugScalar.mockResolvedValue(null);

      await expect(service.removeFromProject('alpha', 'ghost')).rejects.toBeInstanceOf(NotFoundAppException);
      expect(txManager.run).not.toHaveBeenCalled();
    });

    it('404s a missing project before resolving the agent', async () => {
      repo.findProjectBySlug.mockResolvedValue(null);

      await expect(service.removeFromProject('alpha', 'bot')).rejects.toBeInstanceOf(NotFoundAppException);
      expect(repo.findBySlugScalar).not.toHaveBeenCalled();
      expect(txManager.run).not.toHaveBeenCalled();
    });
  });
});
