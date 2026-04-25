import { Test, TestingModule } from '@nestjs/testing';
import { Cron } from '@nestjs/schedule';
import { MemoryGovernanceProcessor } from './memory-governance.processor';
import { MemoryGovernanceService } from './memory-governance.service';
import { PrismaService } from '@nathapp/nestjs-prisma';

const createMockGovernanceService = () => ({
  runCleanup: jest.fn(),
});

const createMockPrismaService = () => ({
  client: {
    project: {
      findMany: jest.fn(),
    },
  },
});

describe('MemoryGovernanceProcessor', () => {
  let processor: MemoryGovernanceProcessor;
  let mockGovernanceService: ReturnType<typeof createMockGovernanceService>;
  let mockPrismaService: ReturnType<typeof createMockPrismaService>;

  beforeEach(async () => {
    mockGovernanceService = createMockGovernanceService();
    mockPrismaService = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoryGovernanceProcessor,
        { provide: MemoryGovernanceService, useValue: mockGovernanceService },
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    processor = module.get<MemoryGovernanceProcessor>(MemoryGovernanceProcessor);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('AC-1: Scheduled cleanup runs daily at 03:00 UTC', () => {
    it('should have @Cron decorator with 0 3 * * * expression', () => {
      const prototype = Object.getPrototypeOf(processor);
      const method = prototype.scheduledCleanup;
      const cronDecorator = Reflect.getMetadata('cron', method);
      expect(cronDecorator).toBe('0 3 * * *');
    });

    it('should have a scheduledCleanup method', () => {
      expect(typeof processor.scheduledCleanup).toBe('function');
    });
  });

  describe('scheduledCleanup', () => {
    it('should call runCleanup for each project', async () => {
      const projects = [{ id: 'proj-1' }, { id: 'proj-2' }];
      mockPrismaService.client.project.findMany.mockResolvedValue(projects);
      mockGovernanceService.runCleanup.mockResolvedValue({
        expiredCount: 0,
        downrankedCount: 0,
        deduplicatedCount: 0,
        supersessionCount: 0,
      });

      await processor.scheduledCleanup();

      expect(mockPrismaService.client.project.findMany).toHaveBeenCalled();
      expect(mockGovernanceService.runCleanup).toHaveBeenCalledTimes(2);
      expect(mockGovernanceService.runCleanup).toHaveBeenCalledWith('proj-1');
      expect(mockGovernanceService.runCleanup).toHaveBeenCalledWith('proj-2');
    });

    it('should handle when no projects exist', async () => {
      mockPrismaService.client.project.findMany.mockResolvedValue([]);

      await processor.scheduledCleanup();

      expect(mockGovernanceService.runCleanup).not.toHaveBeenCalled();
    });

    it('should continue processing other projects if one throws', async () => {
      const projects = [{ id: 'proj-1' }, { id: 'proj-2' }];
      mockPrismaService.client.project.findMany.mockResolvedValue(projects);
      mockGovernanceService.runCleanup
        .mockRejectedValueOnce(new Error('Cleanup failed'))
        .mockResolvedValueOnce({
          expiredCount: 0,
          downrankedCount: 0,
          deduplicatedCount: 0,
          supersessionCount: 0,
        });

      await expect(processor.scheduledCleanup()).rejects.toThrow('Cleanup failed');
      expect(mockGovernanceService.runCleanup).toHaveBeenCalledTimes(2);
    });
  });
});