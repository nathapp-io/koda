import { ValidationAppException } from '@nathapp/nestjs-common';
import { MEMORY_EXPORT_SETTLE_MS, MemoryGovernanceService } from './memory-governance.service';
import { encodeMemoryExportCursor } from './memory-export-cursor';
import type { MemoryItem, MemoryItemOwner } from './memory-item-repository';
import type { PrismaMemoryItemRepository } from './prisma-memory-item.repository';

/** The caller the export reads for: an agent, whose user rows key on `AGENT:<id>`. */
const owner: MemoryItemOwner = { ownerType: 'AGENT', ownerId: 'agent-a' };

const item = (over: Partial<MemoryItem> = {}): MemoryItem => ({
  id: 'mem-1',
  projectId: 'project-1',
  scope: 'project',
  kind: 'NOTE',
  subject: 'replay-budget',
  predicate: 'project',
  object: 'Budget stays 2,048 MiB.',
  description: 'replay budget',
  status: 'active',
  confidence: 0.8,
  createdAt: new Date('2026-11-21T09:00:00.000Z'),
  updatedAt: new Date('2026-11-21T09:01:00.000Z'),
  ...over,
});

describe('MemoryGovernanceService.exportProjectMemory (memory-notes US-006)', () => {
  let repository: { findChangedAfter: ReturnType<typeof vi.fn> };
  let service: MemoryGovernanceService;

  beforeEach(() => {
    repository = { findChangedAfter: vi.fn().mockResolvedValue([]) };
    service = new MemoryGovernanceService(repository as unknown as PrismaMemoryItemRepository);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('AC-4: the settle window ends 5000 ms before the clock', async () => {
    const now = new Date('2026-11-21T09:03:00.000Z');
    vi.useFakeTimers({ now });

    await service.exportProjectMemory('project-1', owner, undefined, 100);

    expect(MEMORY_EXPORT_SETTLE_MS).toBe(5000);
    expect(repository.findChangedAfter).toHaveBeenCalledWith(
      { projectId: 'project-1', ownerKey: 'AGENT:agent-a' },
      null,
      new Date(now.getTime() - MEMORY_EXPORT_SETTLE_MS),
      100,
    );
  });

  it('AC-4: a since is decoded into the keyset position the read starts after', async () => {
    const now = new Date('2026-11-21T09:03:00.000Z');
    vi.useFakeTimers({ now });
    const since = encodeMemoryExportCursor({ updatedAt: new Date('2026-11-21T08:00:00.000Z'), id: 'mem-7' });

    await service.exportProjectMemory('project-1', owner, since, 250);

    expect(repository.findChangedAfter).toHaveBeenCalledWith(
      { projectId: 'project-1', ownerKey: 'AGENT:agent-a' },
      { updatedAt: new Date('2026-11-21T08:00:00.000Z'), id: 'mem-7' },
      new Date(now.getTime() - MEMORY_EXPORT_SETTLE_MS),
      250,
    );
  });

  it('AC-4: a blank since is no cursor at all, and an unreadable one is a 400 naming since', async () => {
    await service.exportProjectMemory('project-1', owner, '  ', 100);
    expect(repository.findChangedAfter.mock.calls[0][1]).toBeNull();

    const error = await service.exportProjectMemory('project-1', owner, 'garbage', 100).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ValidationAppException);
    expect((error as ValidationAppException).args).toEqual({ field: 'since' });
    expect(repository.findChangedAfter).toHaveBeenCalledTimes(1);
  });

  it('AC-4: nextCursor names the last item, and hasMore is true exactly when the page is full', async () => {
    const rows = [item({ id: 'mem-1' }), item({ id: 'mem-2', updatedAt: new Date('2026-11-21T09:02:00.000Z') })];
    repository.findChangedAfter.mockResolvedValue(rows);

    const page = await service.exportProjectMemory('project-1', owner, undefined, 2);

    expect(page.items).toEqual(rows);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe(
      encodeMemoryExportCursor({ updatedAt: rows[1].updatedAt, id: rows[1].id }),
    );
  });

  it('AC-4: a short page is hasMore false and still carries the last item as its cursor', async () => {
    const rows = [item({ id: 'mem-1' })];
    repository.findChangedAfter.mockResolvedValue(rows);

    const page = await service.exportProjectMemory('project-1', owner, undefined, 2);

    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBe(encodeMemoryExportCursor({ updatedAt: rows[0].updatedAt, id: rows[0].id }));
  });

  it('AC-4: an empty page echoes the since it was given, and null when it was given none', async () => {
    const since = encodeMemoryExportCursor({ updatedAt: new Date('2026-11-21T08:00:00.000Z'), id: 'mem-7' });

    await expect(service.exportProjectMemory('project-1', owner, since, 100)).resolves.toEqual({
      items: [], nextCursor: since, hasMore: false,
    });
    await expect(service.exportProjectMemory('project-1', owner, undefined, 100)).resolves.toEqual({
      items: [], nextCursor: null, hasMore: false,
    });
  });
});
