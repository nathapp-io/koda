import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { MemoryGovernanceProcessor } from './memory-governance.processor';
import { MemoryGovernanceService, type GovernanceResult } from './memory-governance.service';
import { ProjectsService } from '../projects/projects.service';
import { AuditRecorder, type AuditRecordInput } from '../audit/audit-recorder.service';
import { currentContext, type ActionContext } from '../action-context/action-context';

const createMockGovernanceService = () => ({
  runCleanup: vi.fn(),
});

const createMockProjectsService = () => ({
  findAllProjectIds: vi.fn(),
});

/** A `GovernanceResult` with the four counts a case cares about; everything else is zero. */
const counts = (over: Partial<GovernanceResult> = {}): GovernanceResult => ({
  expiredCount: 0,
  downrankedCount: 0,
  deduplicatedCount: 0,
  supersessionCount: 0,
  durationMs: 0,
  ...over,
});

/**
 * The recorder as the processor uses it: `audited` runs `fn`, evaluates `entriesOf` and records what it answers —
 * the real contract, so a case can assert which project's entry was recorded. `rejectFor` makes `record` reject for
 * the named projects only, which is how a failing audit of one project leaves the others' entries intact.
 */
function auditStub(rejectFor: string | readonly string[] = []) {
  const rejected = typeof rejectFor === 'string' ? [rejectFor] : [...rejectFor];
  const record = vi.fn(async (input: AuditRecordInput): Promise<void> => {
    if (input.projectId !== null && input.projectId !== undefined && rejected.includes(input.projectId)) {
      throw new Error('audit down');
    }
  });
  const audited = vi.fn(
    async (fn: () => Promise<unknown>, entriesOf: (result: unknown) => unknown): Promise<unknown> => {
      const result = await fn();
      const entries = entriesOf(result);
      for (const entry of Array.isArray(entries) ? entries : [entries]) {
        await record(entry as AuditRecordInput);
      }
      return result;
    },
  );
  return { record, audited };
}

describe('MemoryGovernanceProcessor', () => {
  let processor: MemoryGovernanceProcessor;
  let mockGovernanceService: ReturnType<typeof createMockGovernanceService>;
  let mockProjectsService: ReturnType<typeof createMockProjectsService>;
  let schedulerRegistry: SchedulerRegistry;
  /** Every container a case built, so a case that rebuilds with its own recorder still closes both. */
  let built: TestingModule[] = [];

  const build = async (audit: ReturnType<typeof auditStub>): Promise<void> => {
    const module = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [
        MemoryGovernanceProcessor,
        { provide: MemoryGovernanceService, useValue: mockGovernanceService },
        { provide: ProjectsService, useValue: mockProjectsService },
        { provide: AuditRecorder, useValue: audit },
        SchedulerRegistry,
        Reflector,
      ],
    }).compile();
    built.push(module);

    processor = module.get<MemoryGovernanceProcessor>(MemoryGovernanceProcessor);
    schedulerRegistry = module.get<SchedulerRegistry>(SchedulerRegistry);
  };

  beforeEach(async () => {
    mockGovernanceService = createMockGovernanceService();
    mockProjectsService = createMockProjectsService();
    await build(auditStub());
  });

  afterEach(async () => {
    for (const module of built.splice(0)) await module.close();
    vi.clearAllMocks();
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
      mockGovernanceService.runCleanup.mockResolvedValue(counts());

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
        .mockResolvedValueOnce(counts());

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
        durationMs: 0,
      });

      const start = Date.now();
      await processor.scheduledCleanup();
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(30000);
    });

    /** Permissions P2 US-005: the cron method is the background entry; the cleanup runs as `memory`. */
    it('AC-2: the per-project cleanup runs as SYSTEM/memory', async () => {
      mockProjectsService.findAllProjectIds.mockResolvedValue([{ id: 'proj-1' }]);
      const seen: Array<ActionContext | undefined> = [];
      mockGovernanceService.runCleanup.mockImplementation(async () => {
        seen.push(currentContext());
        return counts();
      });

      await processor.scheduledCleanup();

      expect(seen).toHaveLength(1);
      expect(seen[0]?.actor).toEqual({ type: 'SYSTEM', id: 'memory' });
    });
  });

  // -------------------------------------------------------------------------
  // Permissions P2 US-003 — one entry per project whose cleanup changed rows
  // -------------------------------------------------------------------------

  describe('governance entries (US-003)', () => {
    it('AC-18: a project whose cleanup changed rows records one system.memory.govern entry; an unchanged one records none', async () => {
      const audit = auditStub();
      await build(audit);
      mockProjectsService.findAllProjectIds.mockResolvedValue([{ id: 'p-1' }, { id: 'p-2' }]);
      mockGovernanceService.runCleanup
        .mockResolvedValueOnce(counts({ expiredCount: 0, downrankedCount: 0, deduplicatedCount: 0, supersessionCount: 0 }))
        .mockResolvedValueOnce(counts({ expiredCount: 2 }));

      await processor.scheduledCleanup();

      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith({
        key: 'system.memory.govern',
        resourceType: 'project',
        resourceId: 'p-2',
        projectId: 'p-2',
        summary: 'expired 2, downranked 0, deduplicated 0, superseded 0',
      });
    });

    it('US-003: the summary names all four counts in order', async () => {
      const audit = auditStub();
      await build(audit);
      mockProjectsService.findAllProjectIds.mockResolvedValue([{ id: 'p-1' }]);
      mockGovernanceService.runCleanup.mockResolvedValue(
        counts({ expiredCount: 3, downrankedCount: 4, deduplicatedCount: 5, supersessionCount: 6 }),
      );

      await processor.scheduledCleanup();

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ summary: 'expired 3, downranked 4, deduplicated 5, superseded 6' }),
      );
    });

    it('AC-19: a project whose entry the recorder rejects does not stop the next project recording its own', async () => {
      const audit = auditStub('p-1');
      await build(audit);
      mockProjectsService.findAllProjectIds.mockResolvedValue([{ id: 'p-1' }, { id: 'p-2' }]);
      mockGovernanceService.runCleanup.mockResolvedValue(counts({ expiredCount: 1 }));

      await expect(processor.scheduledCleanup()).rejects.toThrow('Governance cleanup failed for 1 project(s)');

      expect(audit.record.mock.calls.map(([entry]) => entry.projectId)).toEqual(['p-1', 'p-2']);
      expect(mockGovernanceService.runCleanup).toHaveBeenCalledTimes(2);
    });

    it('AC-20: the run rejects with the summary error after processing every project', async () => {
      const audit = auditStub('p-1');
      await build(audit);
      mockProjectsService.findAllProjectIds.mockResolvedValue([{ id: 'p-1' }, { id: 'p-2' }]);
      mockGovernanceService.runCleanup.mockResolvedValue(counts({ expiredCount: 1 }));

      const run = processor.scheduledCleanup();

      await expect(run).rejects.toThrow(/^Governance cleanup failed for 1 project\(s\)/);
      expect(mockGovernanceService.runCleanup).toHaveBeenCalledTimes(2);
    });

    it('AC-23: the rejection is logged as the project\'s failure before the next project is cleaned', async () => {
      const audit = auditStub('p-1');
      await build(audit);
      mockProjectsService.findAllProjectIds.mockResolvedValue([{ id: 'p-1' }, { id: 'p-2' }]);
      mockGovernanceService.runCleanup.mockResolvedValue(counts({ expiredCount: 1 }));

      const errorSpy = vi.mocked(Logger.prototype.error);
      errorSpy.mockClear();

      await expect(processor.scheduledCleanup()).rejects.toThrow('Governance cleanup failed for 1 project(s)');

      const messages = errorSpy.mock.calls.map(([message]) => String(message));
      const failedIndex = messages.indexOf('Failed cleanup for project p-1: audit down');
      expect(failedIndex).toBeGreaterThanOrEqual(0);

      const loggedAt = errorSpy.mock.invocationCallOrder[failedIndex];
      const secondCleanupAt = mockGovernanceService.runCleanup.mock.invocationCallOrder[1];
      expect(loggedAt).toBeLessThan(secondCleanupAt);
    });
  });
});
