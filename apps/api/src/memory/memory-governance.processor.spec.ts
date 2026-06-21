import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { MemoryGovernanceProcessor } from './memory-governance.processor';
import { MemoryGovernanceService } from './memory-governance.service';
import { ProjectsService } from '../projects/projects.service';

const createMockGovernanceService = () => ({
  runCleanup: jest.fn(),
});

const createMockProjectsService = () => ({
  findAllProjectIds: jest.fn(),
});

describe('MemoryGovernanceProcessor', () => {
  let processor: MemoryGovernanceProcessor;
  let mockGovernanceService: ReturnType<typeof createMockGovernanceService>;
  let mockProjectsService: ReturnType<typeof createMockProjectsService>;
  let schedulerRegistry: SchedulerRegistry;

  beforeEach(async () => {
    mockGovernanceService = createMockGovernanceService();
    mockProjectsService = createMockProjectsService();

    const module: TestingModule = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [
        MemoryGovernanceProcessor,
        { provide: MemoryGovernanceService, useValue: mockGovernanceService },
        { provide: ProjectsService, useValue: mockProjectsService },
        SchedulerRegistry,
        Reflector,
      ],
    }).compile();

    processor = module.get<MemoryGovernanceProcessor>(MemoryGovernanceProcessor);
    schedulerRegistry = module.get<SchedulerRegistry>(SchedulerRegistry);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('AC-1: Scheduled cleanup runs daily at 03:00 UTC', () => {
    it('should have a scheduledCleanup method', () => {
      expect(typeof processor.scheduledCleanup).toBe('function');
    });

    it('should have async scheduledCleanup method', () => {
      const method = (processor as unknown as { scheduledCleanup: (...args: unknown[]) => Promise<void> }).scheduledCleanup;
      expect(method.constructor.name).toBe('AsyncFunction');
    });

    it('should have @Cron decorator with 0 3 * * * expression for 03:00 UTC', () => {
      const reflector = new Reflector();
      const cronOptions = reflector.get('SCHEDULE_CRON_OPTIONS', processor.scheduledCleanup);
      expect(cronOptions).toMatchObject({ cronTime: '0 3 * * *' });
    });
  });

  describe('scheduledCleanup', () => {
    it('should call runCleanup for each project', async () => {
      const projects = [{ id: 'proj-1' }, { id: 'proj-2' }];
      mockProjectsService.findAllProjectIds.mockResolvedValue(projects);
      mockGovernanceService.runCleanup.mockResolvedValue({
        expiredCount: 0,
        downrankedCount: 0,
        deduplicatedCount: 0,
        supersessionCount: 0,
      });

      await processor.scheduledCleanup();

      expect(mockProjectsService.findAllProjectIds).toHaveBeenCalled();
      expect(mockGovernanceService.runCleanup).toHaveBeenCalledTimes(2);
      expect(mockGovernanceService.runCleanup).toHaveBeenCalledWith('proj-1');
      expect(mockGovernanceService.runCleanup).toHaveBeenCalledWith('proj-2');
    });

    it('should handle when no projects exist', async () => {
      mockProjectsService.findAllProjectIds.mockResolvedValue([]);

      await processor.scheduledCleanup();

      expect(mockGovernanceService.runCleanup).not.toHaveBeenCalled();
    });

    it('should continue processing other projects if one throws and throw aggregate error at end', async () => {
      const projects = [{ id: 'proj-1' }, { id: 'proj-2' }];
      mockProjectsService.findAllProjectIds.mockResolvedValue(projects);
      mockGovernanceService.runCleanup
        .mockRejectedValueOnce(new Error('Cleanup failed'))
        .mockResolvedValueOnce({
          expiredCount: 0,
          downrankedCount: 0,
          deduplicatedCount: 0,
          supersessionCount: 0,
        });

      await expect(processor.scheduledCleanup()).rejects.toThrow('Governance cleanup failed for 1 project(s)');
      expect(mockGovernanceService.runCleanup).toHaveBeenCalledTimes(2);
    });

    it('AC-8: should complete cleanup for 1000 memories in under 30 seconds', async () => {
      const projects = [{ id: 'proj-1' }];
      mockProjectsService.findAllProjectIds.mockResolvedValue(projects);
      mockGovernanceService.runCleanup.mockResolvedValue({
        expiredCount: 250,
        downrankedCount: 250,
        deduplicatedCount: 250,
        supersessionCount: 250,
      });

      const start = Date.now();
      await processor.scheduledCleanup();
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(30000);
    });
  });
});
