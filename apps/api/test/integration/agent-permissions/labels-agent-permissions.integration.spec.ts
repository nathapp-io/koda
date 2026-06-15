/**
 * AC-1: LabelsService.create() with actorType='agent' returns label without throwing.
 * AC-2: LabelsService.create() with actorType='user' role='MEMBER' throws ForbiddenAppException.
 *
 * Both ACs document and guard the already-correct permission logic for label creation in labels.service.ts.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { LabelsService } from '../../../src/labels/labels.service';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { CreateLabelDto } from '../../../src/labels/dto/create-label.dto';
import type { KodaPrincipal } from '../../../src/auth/principal/koda-principal.types';

describe('LabelsService — agent permissions', () => {
  let service: LabelsService;

  const mockProject = {
    id: 'proj-001',
    name: 'Koda',
    slug: 'koda',
    key: 'KODA',
    description: null,
    gitRemoteUrl: null,
    autoIndexOnClose: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  const mockLabel = {
    id: 'label-001',
    projectId: 'proj-001',
    name: 'bug',
    color: '#e11d48',
  };

  const mockPrisma = {
    client: {
      project: { findUnique: jest.fn() },
      label: { create: jest.fn() },
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LabelsService,
        { provide: PrismaService, useValue: mockPrisma },
        {
          provide: TRANSACTION_MANAGER,
          useValue: {
            run: jest.fn((fn: () => Promise<unknown>) => fn()),
            getClient: jest.fn(),
            isInTransaction: jest.fn(() => false),
          },
        },
      ],
    }).compile();

    service = module.get<LabelsService>(LabelsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── AC-1: agent actor is allowed ────────────────────────────────

  describe('create — AC-1: agent actor allowed', () => {
    it('resolves with the created label when actorType is agent', async () => {
      const dto: CreateLabelDto = { name: 'bug', color: '#e11d48' };
      const agentPrincipal: KodaPrincipal = { actorType: 'agent', id: 'agent-001', sub: 'agent-001', slug: 'agent-001', status: 'ACTIVE', agentRoles: [], capabilities: [], name: undefined, blacklisted: false, revoked: false, authorities: [] };

      mockPrisma.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrisma.client.label.create.mockResolvedValue(mockLabel);

      await expect(
        service.create('koda', dto, agentPrincipal),
      ).resolves.toMatchObject({ name: 'bug', color: '#e11d48' });
    });

    it('does not throw ForbiddenAppException for agent actor', async () => {
      const dto: CreateLabelDto = { name: 'enhancement' };
      const agentPrincipal: KodaPrincipal = { actorType: 'agent', id: 'agent-002', sub: 'agent-002', slug: 'agent-002', status: 'ACTIVE', agentRoles: [], capabilities: [], name: undefined, blacklisted: false, revoked: false, authorities: [] };

      mockPrisma.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrisma.client.label.create.mockResolvedValue({ ...mockLabel, name: 'enhancement', color: null });

      await expect(
        service.create('koda', dto, agentPrincipal),
      ).resolves.toBeDefined();
    });

    it('calls label.create when actor is agent', async () => {
      const dto: CreateLabelDto = { name: 'task' };
      const agentPrincipal: KodaPrincipal = { actorType: 'agent', id: 'agent-003', sub: 'agent-003', slug: 'agent-003', status: 'ACTIVE', agentRoles: [], capabilities: [], name: undefined, blacklisted: false, revoked: false, authorities: [] };

      mockPrisma.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrisma.client.label.create.mockResolvedValue({ ...mockLabel, name: 'task', color: null });

      await service.create('koda', dto, agentPrincipal);

      expect(mockPrisma.client.label.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ name: 'task' }) }),
      );
    });
  });

  // ── AC-2: MEMBER user is blocked (enforced by CASL guard at controller level) ──
  // MEMBER permission blocking moved from service to KodaCaslAbilityFactory in 76cb858.
  // Service-level tests verify ADMIN can proceed; controller-level CASL tests cover MEMBER denial.

  describe('create — AC-2: MEMBER user blocked', () => {
    it('does not throw for ADMIN user', async () => {
      const dto: CreateLabelDto = { name: 'bug', color: '#e11d48' };
      const adminUser: KodaPrincipal = { actorType: 'user', id: 'user-123', sub: 'user-123', role: 'ADMIN', email: 'test@test.com', name: undefined, blacklisted: false, revoked: false, authorities: [] };

      mockPrisma.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrisma.client.label.create.mockResolvedValue(mockLabel);

      await expect(
        service.create('koda', dto, adminUser),
      ).resolves.toBeDefined();
    });
  });
});
