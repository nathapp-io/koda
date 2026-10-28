import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService, createMockPrismaService } from '@nathapp/nestjs-prisma';
import { PrismaProjectRepository } from './prisma-project.repository';

/**
 * US-001 (fleet S5b knowledge core): the project brief has to survive the
 * Prisma → domain mapping, or every `findBySlug` drops it and the API keeps
 * answering `null` for a brief that is stored. The DB-backed form lives in
 * `test/e2e/api-endpoint/endpoint.e2e.spec.ts` (PATCH then GET); this pins the
 * mapping on the repository boundary without a database.
 */
describe('PrismaProjectRepository — brief (US-001)', () => {
  let testingModule: TestingModule;
  let repository: PrismaProjectRepository;
  let prisma: ReturnType<typeof createMockPrismaService>;

  const row = {
    id: 'proj-1',
    name: 'Koda',
    slug: 'koda',
    key: 'KODA',
    description: 'Fleet platform',
    brief: 'Koda is a fleet platform.',
    gitRemoteUrl: null,
    autoIndexOnClose: true,
    autoAssign: 'OFF',
    graphifyEnabled: false,
    graphifyLastImportedAt: null,
    ciWebhookToken: null,
    deletedAt: null,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
  };

  beforeEach(async () => {
    prisma = createMockPrismaService({ fn: vi.fn });
    prisma.client.project = { findUnique: vi.fn() } as never;

    testingModule = await Test.createTestingModule({
      providers: [PrismaProjectRepository, { provide: PrismaService, useValue: prisma }],
    }).compile();

    repository = testingModule.get(PrismaProjectRepository);
  });

  afterEach(async () => {
    await testingModule.close();
    vi.clearAllMocks();
  });

  it('maps a stored brief onto the domain object', async () => {
    (prisma.client.project.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(row);

    const project = await repository.findBySlug('koda');

    expect(project?.brief).toBe('Koda is a fleet platform.');
  });

  it('F2: soft-deletes atomically by immutable id, never by slug', async () => {
    const updateManyAndReturn = vi.fn().mockResolvedValue([{ ...row, deletedAt: new Date() }]);
    prisma.client.project.updateManyAndReturn = updateManyAndReturn;
    const deleted = await repository.softDeleteById('proj-1');
    expect(updateManyAndReturn).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'proj-1', deletedAt: null }, data: { deletedAt: expect.any(Date) },
    });
    expect(deleted).toMatchObject({ id: 'proj-1', deletedAt: expect.any(Date) });
    expect(prisma.client.project.findUnique).not.toHaveBeenCalled();
  });

  it('F2: a missing or already deleted id returns null', async () => {
    prisma.client.project.updateManyAndReturn = vi.fn().mockResolvedValue([]);
    expect(await repository.softDeleteById('missing')).toBeNull();
  });

  it('maps a null brief as null', async () => {
    (prisma.client.project.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ ...row, brief: null });

    const project = await repository.findBySlug('koda');

    expect(project?.brief).toBeNull();
  });
});
