import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { MemoryController } from './memory.controller';
import { ExtractionService } from './extraction.service';
import { PrismaMemoryItemRepository } from './prisma-memory-item.repository';
import { ProjectAccessService } from '../projects/project-access.service';
import { MemoryKind, ActorRole } from '../common/enums';
import { MemoryItem } from './memory-item-repository';
import type { KodaPrincipal, UserPrincipal, AgentPrincipal } from '../auth/principal/koda-principal.types';

const makeMemoryItem = (overrides: Partial<MemoryItem> = {}): MemoryItem => ({
  id: 'mem-1',
  projectId: 'project-123',
  kind: MemoryKind.FACT,
  subject: 'ticket:1',
  predicate: 'status',
  object: 'active',
  status: 'active',
  confidence: 0.9,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const makeUserPrincipal = (role: string): UserPrincipal => ({
  actorType: 'user',
  id: 'user-1',
  name: undefined,
  blacklisted: false,
  revoked: false,
  authorities: [],
  role: role as UserPrincipal['role'],
  email: 'test@example.com',
});

const makeAgentPrincipal = (): AgentPrincipal => ({
  actorType: 'agent',
  id: 'agent-1',
  name: undefined,
  blacklisted: false,
  revoked: false,
  authorities: [],
  slug: 'my-agent',
  status: 'ACTIVE',
  agentRoles: ['DEVELOPER'],
  capabilities: [],
});

describe('MemoryController', () => {
  let controller: MemoryController;
  let extractionService: jest.Mocked<Partial<ExtractionService>>;
  let repository: jest.Mocked<Partial<PrismaMemoryItemRepository>>;
  let projectAccess: jest.Mocked<Partial<ProjectAccessService>>;

  beforeEach(async () => {
    extractionService = {
      extractFromEvent: jest.fn().mockReturnValue([]),
      recordDecision: jest.fn(),
    };

    repository = {
      upsert: jest.fn(),
    };

    projectAccess = {
      assertProjectMembership: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoryController,
        { provide: ExtractionService, useValue: extractionService },
        { provide: PrismaMemoryItemRepository, useValue: repository },
        { provide: ProjectAccessService, useValue: projectAccess },
      ],
    }).compile();

    controller = module.get<MemoryController>(MemoryController);

    jest.clearAllMocks();
    (projectAccess.assertProjectMembership as jest.Mock).mockResolvedValue(undefined);
  });

  describe('extractFromEvent', () => {
    it('returns empty items when projectId is missing', async () => {
      const principal = makeUserPrincipal(ActorRole.ADMIN);
      const result = await controller.extractFromEvent({ action: 'x', data: {} } as any, principal);
      expect(result).toEqual({ items: [] });
    });

    it('throws ForbiddenAppException for a MEMBER user without project membership', async () => {
      const principal = makeUserPrincipal(ActorRole.MEMBER);
      (projectAccess.assertProjectMembership as jest.Mock).mockRejectedValue(
        new ForbiddenAppException({}, 'projects'),
      );

      await expect(
        controller.extractFromEvent({ projectId: 'project-123', action: 'x', data: {} }, principal),
      ).rejects.toThrow(ForbiddenAppException);
      expect(extractionService.extractFromEvent).not.toHaveBeenCalled();
    });

    it('throws ForbiddenAppException for a VIEWER user without project membership', async () => {
      const principal = makeUserPrincipal(ActorRole.VIEWER);
      (projectAccess.assertProjectMembership as jest.Mock).mockRejectedValue(
        new ForbiddenAppException({}, 'projects'),
      );

      await expect(
        controller.extractFromEvent({ projectId: 'project-123', action: 'x', data: {} }, principal),
      ).rejects.toThrow(ForbiddenAppException);
      expect(extractionService.extractFromEvent).not.toHaveBeenCalled();
    });

    it('allows a MEMBER-role global user who holds a project membership (any role)', async () => {
      const principal = makeUserPrincipal(ActorRole.MEMBER);
      (extractionService.extractFromEvent as jest.Mock).mockReturnValue([
        {
          projectId: 'project-123',
          kind: MemoryKind.FACT,
          subject: 'ticket:1',
          predicate: 'status',
          confidence: 0.9,
        },
      ]);
      (repository.upsert as jest.Mock).mockResolvedValue(makeMemoryItem());

      const result = await controller.extractFromEvent(
        { projectId: 'project-123', action: 'status_changed', data: {} },
        principal,
      );
      expect(result.items).toHaveLength(1);
    });

    it('extracts and upserts items for ADMIN user', async () => {
      const principal = makeUserPrincipal(ActorRole.ADMIN);
      const extracted = [
        {
          projectId: 'project-123',
          kind: MemoryKind.FACT,
          subject: 'ticket:1',
          predicate: 'status',
          object: 'active',
          confidence: 0.9,
        },
      ];
      (extractionService.extractFromEvent as jest.Mock).mockReturnValue(extracted);
      (repository.upsert as jest.Mock).mockResolvedValue(makeMemoryItem());

      const event = {
        type: 'ticket_event',
        id: 'evt-1',
        projectId: 'project-123',
        actorId: 'actor-1',
        action: 'status_changed',
        data: { newStatus: 'active' },
      };

      const result = await controller.extractFromEvent(event, principal);

      expect(extractionService.extractFromEvent).toHaveBeenCalledWith(event);
      expect(repository.upsert).toHaveBeenCalledTimes(1);
      expect(result.items).toHaveLength(1);
    });

    it('extracts and upserts items for DEVELOPER user', async () => {
      const principal = makeUserPrincipal(ActorRole.DEVELOPER);
      (extractionService.extractFromEvent as jest.Mock).mockReturnValue([
        {
          projectId: 'project-123',
          kind: MemoryKind.FACT,
          subject: 'ticket:1',
          predicate: 'status',
          confidence: 0.9,
        },
      ]);
      (repository.upsert as jest.Mock).mockResolvedValue(makeMemoryItem());

      const result = await controller.extractFromEvent(
        { projectId: 'project-123', action: 'status_changed', data: {} },
        principal,
      );
      expect(result.items).toHaveLength(1);
    });

    it('allows agent principals to extract', async () => {
      const principal = makeAgentPrincipal();
      (extractionService.extractFromEvent as jest.Mock).mockReturnValue([
        {
          projectId: 'project-123',
          kind: MemoryKind.FACT,
          subject: 'ticket:1',
          predicate: 'status',
          confidence: 0.9,
        },
      ]);
      (repository.upsert as jest.Mock).mockResolvedValue(makeMemoryItem());

      const result = await controller.extractFromEvent(
        { projectId: 'project-123', action: 'status_changed', data: {} },
        principal,
      );
      expect(result.items).toHaveLength(1);
    });

    it('returns empty items array when extraction yields no items', async () => {
      const principal = makeUserPrincipal(ActorRole.ADMIN);
      (extractionService.extractFromEvent as jest.Mock).mockReturnValue([]);

      const result = await controller.extractFromEvent(
        { projectId: 'project-123', action: 'status_changed', data: {} },
        principal,
      );
      expect(result).toEqual({ items: [] });
      expect(repository.upsert).not.toHaveBeenCalled();
    });

    it('H12 follow-up: extract with decision_event payload does not create a DECISION item via the HTTP route', async () => {
      const principal = makeUserPrincipal(ActorRole.ADMIN);
      (extractionService.extractFromEvent as jest.Mock).mockReturnValue([
        {
          projectId: 'project-123',
          kind: MemoryKind.DECISION,
          subject: 'agent:victim',
          predicate: 'decision',
          object: 'use microservices',
          sourceType: 'decision_event',
          sourceId: 'evt-1',
          confidence: 1.0,
        },
      ]);
      (repository.upsert as jest.Mock).mockResolvedValue(makeMemoryItem());

      const result = await controller.extractFromEvent(
        { projectId: 'project-123', type: 'decision_event', action: 'decided', data: {}, agentId: 'victim' },
        principal,
      );

      // Filtered silently — nothing persisted, nothing echoed back.
      expect(result.items).toEqual([]);
      expect(repository.upsert).not.toHaveBeenCalled();
    });

    it('H12 follow-up: extract with agent_event decision_made payload does not create a DECISION item', async () => {
      const principal = makeAgentPrincipal();
      (extractionService.extractFromEvent as jest.Mock).mockReturnValue([
        {
          projectId: 'project-123',
          kind: MemoryKind.DECISION,
          subject: 'agent:victim',
          predicate: 'decision',
          object: 'use microservices',
          sourceType: 'agent_event',
          sourceId: 'evt-2',
          confidence: 0.95,
        },
      ]);
      (repository.upsert as jest.Mock).mockResolvedValue(makeMemoryItem());

      const result = await controller.extractFromEvent(
        { projectId: 'project-123', type: 'agent_event', action: 'decision_made', data: { decision: 'x' }, agentId: 'victim' },
        principal,
      );

      expect(result.items).toEqual([]);
      expect(repository.upsert).not.toHaveBeenCalled();
    });

    it('H12 follow-up: non-DECISION items are still extracted while DECISION items are filtered (positive control)', async () => {
      const principal = makeUserPrincipal(ActorRole.ADMIN);
      const factItem = {
        projectId: 'project-123',
        kind: MemoryKind.FACT,
        subject: 'ticket:1',
        predicate: 'status',
        object: 'active',
        sourceType: 'ticket_event',
        sourceId: 'evt-3',
        confidence: 0.9,
      };
      const decisionItem = {
        projectId: 'project-123',
        kind: MemoryKind.DECISION,
        subject: 'agent:victim',
        predicate: 'decision',
        object: 'forged',
        confidence: 1.0,
      };
      (extractionService.extractFromEvent as jest.Mock).mockReturnValue([decisionItem, factItem]);
      (repository.upsert as jest.Mock).mockResolvedValue(makeMemoryItem());

      const result = await controller.extractFromEvent(
        { projectId: 'project-123', type: 'ticket_event', action: 'status_changed', data: {} },
        principal,
      );

      expect(result.items).toEqual([factItem]);
      expect(repository.upsert).toHaveBeenCalledTimes(1);
      expect(repository.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ kind: MemoryKind.FACT, ownerId: 'user-1' }),
      );
    });

    it('H12: extract uses principal.id as ownerId, not event.actorId', async () => {
      const principal = makeUserPrincipal(ActorRole.ADMIN);
      (extractionService.extractFromEvent as jest.Mock).mockReturnValue([
        {
          projectId: 'project-123',
          kind: MemoryKind.FACT,
          subject: 'ticket:1',
          predicate: 'status',
          object: 'active',
          confidence: 0.9,
        },
      ]);
      (repository.upsert as jest.Mock).mockResolvedValue(makeMemoryItem());

      const event = {
        type: 'ticket_event',
        id: 'evt-1',
        projectId: 'project-123',
        actorId: 'victim',
        action: 'status_changed',
        data: { newStatus: 'active' },
      };

      await controller.extractFromEvent(event as any, principal);

      expect(repository.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: 'user-1' }),
      );
      expect(repository.upsert).not.toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: 'victim' }),
      );
    });
  });

  describe('recordDecision', () => {
    it('delegates to extractionService.recordDecision and returns the result', async () => {
      const principal = makeUserPrincipal(ActorRole.ADMIN);
      const writeResult = { canonicalId: 'src-1', memoryId: 'mem-1' };
      (extractionService.recordDecision as jest.Mock).mockResolvedValue(writeResult);

      const input = {
        projectId: 'project-123',
        actorId: 'actor-1',
        topic: 'architecture',
        decision: 'use microservices',
        rationale: 'scalability',
        sourceId: 'src-1',
      };

      const result = await controller.recordDecision(input, principal);

      expect(projectAccess.assertProjectMembership).toHaveBeenCalledWith('project-123', principal);
      expect(extractionService.recordDecision).toHaveBeenCalledWith(
        {
          projectId: 'project-123',
          actorId: 'actor-1',
          topic: 'architecture',
          decision: 'use microservices',
          rationale: 'scalability',
          sourceId: 'src-1',
        },
        repository,
      );
      expect(result).toEqual(writeResult);
    });

    it('throws ForbiddenAppException for MEMBER user without project membership', async () => {
      const principal = makeUserPrincipal(ActorRole.MEMBER);
      (projectAccess.assertProjectMembership as jest.Mock).mockRejectedValue(
        new ForbiddenAppException({}, 'projects'),
      );

      await expect(
        controller.recordDecision(
          { projectId: 'project-123', topic: 't', decision: 'd' },
          principal,
        ),
      ).rejects.toThrow(ForbiddenAppException);
      expect(extractionService.recordDecision).not.toHaveBeenCalled();
      expect(projectAccess.assertProjectMembership).toHaveBeenCalledWith('project-123', principal);
    });

    it('throws ForbiddenAppException when the caller is not a member of the named project', async () => {
      const principal = makeUserPrincipal(ActorRole.DEVELOPER);
      (projectAccess.assertProjectMembership as jest.Mock).mockRejectedValue(new ForbiddenAppException({}, 'projects'));

      await expect(
        controller.recordDecision(
          { projectId: 'project-other', topic: 't', decision: 'd' },
          principal,
        ),
      ).rejects.toThrow(ForbiddenAppException);
      expect(extractionService.recordDecision).not.toHaveBeenCalled();
    });

    it('ignores a non-admin-supplied actorId and records the decision as the caller', async () => {
      const principal = makeUserPrincipal(ActorRole.DEVELOPER);
      (extractionService.recordDecision as jest.Mock).mockResolvedValue({ canonicalId: 'x', memoryId: 'y' });

      await controller.recordDecision(
        { projectId: 'project-123', actorId: 'someone-else', topic: 't', decision: 'd' },
        principal,
      );

      expect(extractionService.recordDecision).toHaveBeenCalledWith(
        expect.objectContaining({ actorId: 'user-1' }),
        repository,
      );
    });

    it('honors an admin-supplied actorId', async () => {
      const principal = makeUserPrincipal(ActorRole.ADMIN);
      (extractionService.recordDecision as jest.Mock).mockResolvedValue({ canonicalId: 'x', memoryId: 'y' });

      await controller.recordDecision(
        { projectId: 'project-123', actorId: 'attributed-actor', topic: 't', decision: 'd' },
        principal,
      );

      expect(extractionService.recordDecision).toHaveBeenCalledWith(
        expect.objectContaining({ actorId: 'attributed-actor' }),
        repository,
      );
    });
  });

  describe('createMemory', () => {
    it('creates a memory item for ADMIN user', async () => {
      const principal = makeUserPrincipal(ActorRole.ADMIN);
      const created = makeMemoryItem();
      (repository.upsert as jest.Mock).mockResolvedValue(created);

      const input = {
        projectId: 'project-123',
        kind: MemoryKind.FACT,
        subject: 'ticket:1',
        predicate: 'status',
        object: 'active',
      };

      const result = await controller.createMemory(input, principal);

      expect(projectAccess.assertProjectMembership).toHaveBeenCalledWith('project-123', principal);
      expect(repository.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'project-123',
          kind: MemoryKind.FACT,
          subject: 'ticket:1',
          predicate: 'status',
          object: 'active',
          sourceType: 'manual',
          confidence: 0.8,
          ownerId: 'user-1',
        }),
      );
      expect(result).toEqual(created);
    });

    it('throws ForbiddenAppException for MEMBER user without project membership', async () => {
      const principal = makeUserPrincipal(ActorRole.MEMBER);
      (projectAccess.assertProjectMembership as jest.Mock).mockRejectedValue(
        new ForbiddenAppException({}, 'projects'),
      );

      await expect(
        controller.createMemory(
          {
            projectId: 'project-123',
            kind: MemoryKind.FACT,
            subject: 'ticket:1',
            predicate: 'status',
          },
          principal,
        ),
      ).rejects.toThrow(ForbiddenAppException);
      expect(repository.upsert).not.toHaveBeenCalled();
      expect(projectAccess.assertProjectMembership).toHaveBeenCalledWith('project-123', principal);
    });

    it('throws ForbiddenAppException for VIEWER user without project membership', async () => {
      const principal = makeUserPrincipal(ActorRole.VIEWER);
      (projectAccess.assertProjectMembership as jest.Mock).mockRejectedValue(
        new ForbiddenAppException({}, 'projects'),
      );

      await expect(
        controller.createMemory(
          {
            projectId: 'project-123',
            kind: MemoryKind.FACT,
            subject: 'ticket:1',
            predicate: 'status',
          },
          principal,
        ),
      ).rejects.toThrow(ForbiddenAppException);
      expect(repository.upsert).not.toHaveBeenCalled();
    });

    it('allows a MEMBER-role global user who holds a project DEVELOPER membership (resolves lockout)', async () => {
      const principal = makeUserPrincipal(ActorRole.MEMBER);
      (repository.upsert as jest.Mock).mockResolvedValue(makeMemoryItem());

      // With a ProjectMember row (mock membership check passes), a user whose
      // GLOBAL role is only MEMBER may write memory to the project.
      const result = await controller.createMemory(
        {
          projectId: 'project-123',
          kind: MemoryKind.FACT,
          subject: 'ticket:1',
          predicate: 'status',
        },
        principal,
      );

      expect(result).toEqual(makeMemoryItem());
      expect(projectAccess.assertProjectMembership).toHaveBeenCalledWith('project-123', principal);
    });

    it('throws ForbiddenAppException when the caller is not a member of the named project', async () => {
      const principal = makeUserPrincipal(ActorRole.DEVELOPER);
      (projectAccess.assertProjectMembership as jest.Mock).mockRejectedValue(new ForbiddenAppException({}, 'projects'));

      await expect(
        controller.createMemory(
          {
            projectId: 'project-other',
            kind: MemoryKind.FACT,
            subject: 'ticket:1',
            predicate: 'status',
          },
          principal,
        ),
      ).rejects.toThrow(ForbiddenAppException);
      expect(repository.upsert).not.toHaveBeenCalled();
    });

    it('uses provided ownerId over principal id', async () => {
      const principal = makeUserPrincipal(ActorRole.ADMIN);
      (repository.upsert as jest.Mock).mockResolvedValue(makeMemoryItem());

      await controller.createMemory(
        {
          projectId: 'project-123',
          kind: MemoryKind.FACT,
          subject: 'ticket:1',
          predicate: 'status',
          ownerId: 'custom-owner',
        },
        principal,
      );

      expect(repository.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: 'custom-owner' }),
      );
    });

    it('H12: generic POST forces ownerId to principal for non-admin users', async () => {
      const principal = makeUserPrincipal(ActorRole.DEVELOPER);
      (repository.upsert as jest.Mock).mockResolvedValue(makeMemoryItem());

      await controller.createMemory(
        {
          projectId: 'project-123',
          kind: MemoryKind.FACT,
          subject: 'ticket:1',
          predicate: 'status',
          ownerId: 'victim',
        },
        principal,
      );

      expect(repository.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: principal.id }),
      );
      expect(repository.upsert).not.toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: 'victim' }),
      );
    });

    it('H12: generic POST forces ownerId to principal for agents too', async () => {
      const principal = makeAgentPrincipal();
      (repository.upsert as jest.Mock).mockResolvedValue(makeMemoryItem());

      await controller.createMemory(
        {
          projectId: 'project-123',
          kind: MemoryKind.FACT,
          subject: 'ticket:1',
          predicate: 'status',
          ownerId: 'victim',
        },
        principal,
      );

      expect(repository.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: 'agent-1' }),
      );
    });

    it('H12: generic POST rejects kind=DECISION with a validation error pointing at /decisions', async () => {
      const principal = makeUserPrincipal(ActorRole.DEVELOPER);

      await expect(
        controller.createMemory(
          {
            projectId: 'project-123',
            kind: MemoryKind.DECISION,
            subject: 'agent:victim',
            predicate: 'p',
            object: 'o',
          },
          principal,
        ),
      ).rejects.toThrow(ValidationAppException);
      expect(repository.upsert).not.toHaveBeenCalled();
    });

    it('uses provided confidence over default 0.8', async () => {
      const principal = makeUserPrincipal(ActorRole.ADMIN);
      (repository.upsert as jest.Mock).mockResolvedValue(makeMemoryItem());

      await controller.createMemory(
        {
          projectId: 'project-123',
          kind: MemoryKind.FACT,
          subject: 'ticket:1',
          predicate: 'status',
          confidence: 0.5,
        },
        principal,
      );

      expect(repository.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ confidence: 0.5 }),
      );
    });

    it('allows agent principals to create memory', async () => {
      const principal = makeAgentPrincipal();
      const created = makeMemoryItem();
      (repository.upsert as jest.Mock).mockResolvedValue(created);

      const result = await controller.createMemory(
        {
          projectId: 'project-123',
          kind: MemoryKind.FACT,
          subject: 'ticket:1',
          predicate: 'status',
        },
        principal,
      );

      expect(result).toEqual(created);
    });
  });
});
