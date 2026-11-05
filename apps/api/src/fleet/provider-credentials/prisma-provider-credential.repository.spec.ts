import { Test, type TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { PrismaService, createMockPrismaService } from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { Prisma } from '../../generated/prisma/client';
import {
  PROVIDER_CREDENTIAL_ORDER_BY,
  PrismaProviderCredentialRepository,
} from './prisma-provider-credential.repository';
import {
  GLOBAL_SCOPE_KEY,
  PROVIDER_AVAILABILITY_MAX_ROWS,
  PROVIDER_CREDENTIAL_PAGE_SIZE_MAX,
  PROVIDER_KEY_SUMMARY_MAX_PAGES,
  PROVIDER_KEY_SUMMARY_PAGE_SIZE,
  scopeKeyFor,
} from './provider-credential.domain';

const now = new Date('2026-11-05T00:00:00.000Z');

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'cred-1',
  scope: 'GLOBAL',
  scopeKey: GLOBAL_SCOPE_KEY,
  projectId: null,
  repoId: null,
  providerId: 'openrouter',
  name: 'fleet',
  encryptedKey: '00:00:00',
  last4: '3456',
  fingerprint: '0123456789ab',
  createdById: 'user-1',
  updatedById: 'user-1',
  disabledAt: null,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const notFound = () =>
  new Prisma.PrismaClientKnownRequestError('Record to update not found', {
    code: 'P2025',
    clientVersion: 'test',
  });

describe('PrismaProviderCredentialRepository', () => {
  let testingModule: TestingModule;
  let repository: PrismaProviderCredentialRepository;
  let prisma: ReturnType<typeof createMockPrismaService>;

  beforeEach(async () => {
    prisma = createMockPrismaService({ fn: vi.fn });
    prisma.client.providerCredential = {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    } as never;
    prisma.client.providerCredentialIssue = { createMany: vi.fn() } as never;

    testingModule = await Test.createTestingModule({
      providers: [
        PrismaProviderCredentialRepository,
        { provide: PrismaService, useValue: prisma },
        {
          provide: TRANSACTION_MANAGER,
          useValue: {
            run: vi.fn(<T>(fn: () => Promise<T>) => fn()),
            getClient: () => prisma.client,
            isInTransaction: () => false,
          },
        },
      ],
    }).compile();

    repository = testingModule.get(PrismaProviderCredentialRepository);
  });

  afterEach(async () => {
    await testingModule.close();
    vi.clearAllMocks();
  });

  describe('scopeKeyFor', () => {
    it('names the three scopes with the strings the unique index relies on', () => {
      expect(scopeKeyFor({ scope: 'GLOBAL' })).toBe('global');
      expect(scopeKeyFor({ scope: 'PROJECT', projectId: 'p1' })).toBe('project:p1');
      expect(scopeKeyFor({ scope: 'REPO', repoId: 'r1' })).toBe('repo:r1');
    });

    it('refuses a scope without the id its key needs', () => {
      expect(() => scopeKeyFor({ scope: 'PROJECT' })).toThrow(/projectId/);
      expect(() => scopeKeyFor({ scope: 'REPO' })).toThrow(/repoId/);
    });
  });

  describe('insert', () => {
    it('derives scopeKey from the scope instead of trusting the caller', async () => {
      (prisma.client.providerCredential.create as ReturnType<typeof vi.fn>).mockResolvedValue(
        row({ scope: 'PROJECT', scopeKey: 'project:p1', projectId: 'p1' }),
      );

      const created = await repository.insert({
        scope: 'PROJECT',
        projectId: 'p1',
        providerId: 'openrouter',
        name: 'fleet',
        encryptedKey: '00:00:00',
        last4: '3456',
        fingerprint: '0123456789ab',
        createdById: 'user-1',
        updatedById: 'user-1',
      });

      expect(prisma.client.providerCredential.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ scopeKey: 'project:p1', projectId: 'p1', repoId: null }),
      });
      expect(created).toMatchObject({ scope: 'PROJECT', scopeKey: 'project:p1' });
    });

    it('stores a REPO key under its repo and project', async () => {
      (prisma.client.providerCredential.create as ReturnType<typeof vi.fn>).mockResolvedValue(
        row({ scope: 'REPO', scopeKey: 'repo:r1', projectId: 'p1', repoId: 'r1' }),
      );

      await repository.insert({
        scope: 'REPO',
        projectId: 'p1',
        repoId: 'r1',
        providerId: 'openrouter',
        name: 'fleet',
        encryptedKey: '00:00:00',
        last4: '3456',
        fingerprint: '0123456789ab',
        createdById: 'user-1',
        updatedById: 'user-1',
      });

      expect(prisma.client.providerCredential.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ scopeKey: 'repo:r1', projectId: 'p1', repoId: 'r1' }),
      });
    });
  });

  describe('resolve lookups', () => {
    it('asks for the global, project and repo keys of one provider', async () => {
      (prisma.client.providerCredential.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        row(),
        row({ scope: 'PROJECT', scopeKey: 'project:p1', projectId: 'p1' }),
        row({ scope: 'REPO', scopeKey: 'repo:r1', projectId: 'p1', repoId: 'r1' }),
      ]);

      const candidates = await repository.findActiveCandidates({
        projectId: 'p1',
        repoId: 'r1',
        providerId: 'openrouter',
      });

      expect(prisma.client.providerCredential.findMany).toHaveBeenCalledWith({
        where: {
          providerId: 'openrouter',
          disabledAt: null,
          scopeKey: { in: ['global', 'project:p1', 'repo:r1'] },
        },
      });
      expect(candidates.map((c) => c.scope)).toEqual(['GLOBAL', 'PROJECT', 'REPO']);
    });

    it('leaves the repo key out when there is no repo', async () => {
      (prisma.client.providerCredential.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await repository.findActiveCandidates({ projectId: 'p1', repoId: null, providerId: 'openrouter' });

      expect(prisma.client.providerCredential.findMany).toHaveBeenCalledWith({
        where: {
          providerId: 'openrouter',
          disabledAt: null,
          scopeKey: { in: ['global', 'project:p1'] },
        },
      });
    });

    /**
     * C10 (branch review B3): the availability read behind placement. One bounded read answers every named
     * scope, always including the global rows, and it never selects the sealed key.
     */
    it('B3: reads the active rows of the named scopes plus the global ones, as metadata only', async () => {
      (prisma.client.providerCredential.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { scope: 'GLOBAL', projectId: null, repoId: null, providerId: 'openrouter' },
        { scope: 'REPO', projectId: 'p1', repoId: 'r1', providerId: 'zai' },
      ]);

      const rows = await repository.listActiveScopes({ projectIds: ['p1'], repoIds: ['r1'] });

      expect(prisma.client.providerCredential.findMany).toHaveBeenCalledWith({
        where: {
          disabledAt: null,
          OR: [{ scopeKey: 'global' }, { projectId: { in: ['p1'] } }, { repoId: { in: ['r1'] } }],
        },
        select: { scope: true, projectId: true, repoId: true, providerId: true },
        orderBy: PROVIDER_CREDENTIAL_ORDER_BY,
        take: PROVIDER_AVAILABILITY_MAX_ROWS + 1,
      });
      expect(rows).toEqual([
        { scope: 'GLOBAL', projectId: null, repoId: null, providerId: 'openrouter' },
        { scope: 'REPO', projectId: 'p1', repoId: 'r1', providerId: 'zai' },
      ]);
    });

    it('B3: truncates an over-cap answer to the bound, keeping the refusal in place', async () => {
      const many = Array.from({ length: PROVIDER_AVAILABILITY_MAX_ROWS + 1 }, (_, i) => ({
        scope: 'GLOBAL', projectId: null, repoId: null, providerId: `p${i}`,
      }));
      (prisma.client.providerCredential.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(many);
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      const rows = await repository.listActiveScopes({ projectIds: ['p1'], repoIds: [] });

      expect(rows).toHaveLength(PROVIDER_AVAILABILITY_MAX_ROWS);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(String(PROVIDER_AVAILABILITY_MAX_ROWS)));
    });

    it('B3: reads no row when the caller named no scope', async () => {
      await expect(repository.listActiveScopes({ projectIds: [], repoIds: [] })).resolves.toEqual([]);
      expect(prisma.client.providerCredential.findMany).not.toHaveBeenCalled();
    });

    it('lists one bounded page of GLOBAL rows for the admin list', async () => {
      (prisma.client.providerCredential.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([row()]);
      (prisma.client.providerCredential.count as ReturnType<typeof vi.fn>).mockResolvedValue(3);

      const page = await repository.listGlobal({ current: 1, size: 1 });

      expect(prisma.client.providerCredential.findMany).toHaveBeenCalledWith({
        skip: 0,
        take: 1,
        where: { scopeKey: 'global' },
        orderBy: PROVIDER_CREDENTIAL_ORDER_BY,
      });
      expect(prisma.client.providerCredential.count).toHaveBeenCalledWith({
        where: { scopeKey: 'global' },
      });
      expect(page).toMatchObject({ total: 3, current: 1, size: 1, hasNext: true, hasPrev: false });
      expect(page.records).toHaveLength(1);
    });

    it('reads a later page of GLOBAL rows by skipping the earlier ones', async () => {
      (prisma.client.providerCredential.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.client.providerCredential.count as ReturnType<typeof vi.fn>).mockResolvedValue(5);

      const page = await repository.listGlobal({ current: 2, size: 2 });

      expect(prisma.client.providerCredential.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 2, take: 2 }),
      );
      expect(page).toMatchObject({ total: 5, current: 2, size: 2, hasNext: true, hasPrev: true });
    });

    it('caps a page at PROVIDER_CREDENTIAL_PAGE_SIZE_MAX instead of fetching everything', async () => {
      (prisma.client.providerCredential.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.client.providerCredential.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

      const page = await repository.listGlobal({ current: 1, size: 10_000 });

      expect(prisma.client.providerCredential.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: PROVIDER_CREDENTIAL_PAGE_SIZE_MAX }),
      );
      expect(page.size).toBe(PROVIDER_CREDENTIAL_PAGE_SIZE_MAX);
    });

    it('lists one bounded page of a project\'s PROJECT and REPO rows by project id', async () => {
      (prisma.client.providerCredential.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.client.providerCredential.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

      await repository.listForProject('p1', { current: 3, size: 4 });

      expect(prisma.client.providerCredential.findMany).toHaveBeenCalledWith({
        skip: 8,
        take: 4,
        where: { projectId: 'p1' },
        orderBy: PROVIDER_CREDENTIAL_ORDER_BY,
      });
      expect(prisma.client.providerCredential.count).toHaveBeenCalledWith({
        where: { projectId: 'p1' },
      });
    });

    it('maps a stored row to the domain shape', async () => {
      (prisma.client.providerCredential.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(row());

      await expect(repository.findById('cred-1')).resolves.toMatchObject({
        id: 'cred-1',
        scope: 'GLOBAL',
        providerId: 'openrouter',
        disabledAt: null,
      });
    });
  });

  describe('patch', () => {
    it('answers the updated row', async () => {
      (prisma.client.providerCredential.update as ReturnType<typeof vi.fn>).mockResolvedValue(
        row({ name: 'rotated', fingerprint: 'ffffffffffff' }),
      );

      await expect(repository.patch('cred-1', { name: 'rotated', fingerprint: 'ffffffffffff' }))
        .resolves.toMatchObject({ name: 'rotated', fingerprint: 'ffffffffffff' });
    });

    it('answers null when the row is gone (P2025), never a raw Prisma error', async () => {
      (prisma.client.providerCredential.update as ReturnType<typeof vi.fn>).mockRejectedValue(notFound());

      await expect(repository.patch('cred-1', { name: 'rotated' })).resolves.toBeNull();
    });
  });

  describe('remove', () => {
    it('reports whether a row was deleted', async () => {
      (prisma.client.providerCredential.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ count: 1 });

      await expect(repository.remove('cred-1')).resolves.toBe(true);
      expect(prisma.client.providerCredential.deleteMany).toHaveBeenCalledWith({ where: { id: 'cred-1' } });
    });

    it('reports false for an id that no longer exists', async () => {
      (prisma.client.providerCredential.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ count: 0 });

      await expect(repository.remove('cred-1')).resolves.toBe(false);
    });
  });

  describe('recordIssue', () => {
    it('reports true when the attribution row was inserted', async () => {
      (prisma.client.providerCredentialIssue.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

      await expect(repository.recordIssue({ jobId: 'job-1', credentialId: 'cred-1', fingerprint: '0123456789ab' }))
        .resolves.toBe(true);
      expect(prisma.client.providerCredentialIssue.createMany).toHaveBeenCalledWith({
        data: [{ jobId: 'job-1', credentialId: 'cred-1', fingerprint: '0123456789ab' }],
        skipDuplicates: true,
      });
    });

    it('reports false for a duplicate hand-out (skip-on-duplicate)', async () => {
      (prisma.client.providerCredentialIssue.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });

      await expect(repository.recordIssue({ jobId: 'job-1', credentialId: 'cred-1', fingerprint: '0123456789ab' }))
        .resolves.toBe(false);
    });
  });

  /**
   * C10 US-007: the credential board's koda column reads every active GLOBAL row — disabled rows
   * filtered out by the query, never by the caller — in the same total order the management list
   * uses, so two renders of the same data agree. The read pages, because creation accepts any valid
   * provider id and nothing bounds the inventory: a silently short board would hide keys that exist.
   */
  describe('listActiveGlobal', () => {
    const page = (offset: number, size = PROVIDER_KEY_SUMMARY_PAGE_SIZE) =>
      Array.from({ length: size }, (_, i) => row({ id: `cred-${offset + i}`, providerId: `provider${offset + i}` }));

    it('reads the first page of active GLOBAL rows in provider order', async () => {
      (prisma.client.providerCredential.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        row(),
        row({ id: 'cred-2', providerId: 'openai' }),
      ]);

      const rows = await repository.listActiveGlobal();

      expect(prisma.client.providerCredential.findMany).toHaveBeenCalledWith({
        where: { scopeKey: 'global', disabledAt: null },
        orderBy: PROVIDER_CREDENTIAL_ORDER_BY,
        skip: 0,
        take: PROVIDER_KEY_SUMMARY_PAGE_SIZE,
      });
      expect(rows.map((r) => r.providerId)).toEqual(['openrouter', 'openai']);
      expect(rows[0]).toMatchObject({ id: 'cred-1', scope: 'GLOBAL' });
    });

    it('pages until the inventory ends, so a 201st GLOBAL key is still listed', async () => {
      const first = page(0);
      const last = page(PROVIDER_KEY_SUMMARY_PAGE_SIZE, 1);
      const findMany = prisma.client.providerCredential.findMany as ReturnType<typeof vi.fn>;
      findMany.mockResolvedValueOnce(first).mockResolvedValueOnce(last);

      const rows = await repository.listActiveGlobal();

      expect(rows).toHaveLength(PROVIDER_KEY_SUMMARY_PAGE_SIZE + 1);
      expect(rows.at(-1)).toMatchObject({ providerId: `provider${PROVIDER_KEY_SUMMARY_PAGE_SIZE}` });
      expect(findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({ skip: 0, take: PROVIDER_KEY_SUMMARY_PAGE_SIZE }));
      expect(findMany).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ skip: PROVIDER_KEY_SUMMARY_PAGE_SIZE, take: PROVIDER_KEY_SUMMARY_PAGE_SIZE }),
      );
    });

    it('fails loudly past the safety bound instead of answering a short board', async () => {
      // A page that is always full means the loop can only end at the bound.
      const findMany = prisma.client.providerCredential.findMany as ReturnType<typeof vi.fn>;
      findMany.mockImplementation(async ({ skip }: { skip: number }) => page(skip));
      const failure = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      await expect(repository.listActiveGlobal()).rejects.toThrow(/GLOBAL/);

      expect(findMany).toHaveBeenCalledTimes(PROVIDER_KEY_SUMMARY_MAX_PAGES);
      expect(failure).toHaveBeenCalled();
      failure.mockRestore();
    });
  });
});
