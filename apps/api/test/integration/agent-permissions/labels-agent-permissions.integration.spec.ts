/**
 * AC-1: LabelsService.create() with actorType='agent' returns label without throwing.
 * AC-2: LabelsService.create() with actorType='user' role='MEMBER' throws ForbiddenAppException.
 *
 * Both ACs document and guard the already-correct permission logic for label creation in labels.service.ts.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { LabelsService } from '../../../src/labels/labels.service';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { CreateLabelDto } from '../../../src/labels/dto/create-label.dto';

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
      const agentPrincipal = { id: 'agent-001', sub: 'agent-001' };

      mockPrisma.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrisma.client.label.create.mockResolvedValue(mockLabel);

      await expect(
        service.create('koda', dto, agentPrincipal, 'agent'),
      ).resolves.toMatchObject({ name: 'bug', color: '#e11d48' });
    });

    it('does not throw ForbiddenAppException for agent actor', async () => {
      const dto: CreateLabelDto = { name: 'enhancement' };
      const agentPrincipal = { id: 'agent-002', sub: 'agent-002' };

      mockPrisma.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrisma.client.label.create.mockResolvedValue({ ...mockLabel, name: 'enhancement', color: null });

      await expect(
        service.create('koda', dto, agentPrincipal, 'agent'),
      ).resolves.toBeDefined();
    });

    it('calls label.create when actor is agent', async () => {
      const dto: CreateLabelDto = { name: 'task' };
      const agentPrincipal = { id: 'agent-003', sub: 'agent-003' };

      mockPrisma.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrisma.client.label.create.mockResolvedValue({ ...mockLabel, name: 'task', color: null });

      await service.create('koda', dto, agentPrincipal, 'agent');

      expect(mockPrisma.client.label.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ name: 'task' }) }),
      );
    });
  });

  // ── AC-2: MEMBER user is blocked ────────────────────────────────

  describe('create — AC-2: MEMBER user blocked', () => {
    it('throws when actorType is user with role MEMBER', async () => {
      const dto: CreateLabelDto = { name: 'bug', color: '#e11d48' };
      const memberUser = { id: 'user-456', sub: 'user-456', role: 'MEMBER' };

      await expect(
        service.create('koda', dto, memberUser, 'user'),
      ).rejects.toThrow();
    });

    it('throws before querying the database for MEMBER user', async () => {
      const dto: CreateLabelDto = { name: 'bug', color: '#e11d48' };
      const memberUser = { id: 'user-456', sub: 'user-456', role: 'MEMBER' };

      await expect(
        service.create('koda', dto, memberUser, 'user'),
      ).rejects.toThrow();

      expect(mockPrisma.client.project.findUnique).not.toHaveBeenCalled();
    });

    it('does not throw for ADMIN user', async () => {
      const dto: CreateLabelDto = { name: 'bug', color: '#e11d48' };
      const adminUser = { id: 'user-123', sub: 'user-123', role: 'ADMIN' };

      mockPrisma.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrisma.client.label.create.mockResolvedValue(mockLabel);

      await expect(
        service.create('koda', dto, adminUser, 'user'),
      ).resolves.toBeDefined();
    });
  });
});
