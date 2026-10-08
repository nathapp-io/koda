import { Test, TestingModule } from '@nestjs/testing';
import { SymbolStore } from '../../src/code-intel/symbol-store';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { PrismaCodeIntelRepository } from '../../src/code-intel/prisma-code-intel.repository';

describe('SymbolStore', () => {
  let store: SymbolStore;
  let prismaService: jest.Mocked<PrismaService<PrismaClient>>;

  const mockPrismaClient = {
    symbol: {
      upsert: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    $queryRawUnsafe: jest.fn(),
  };

  const mockTxManager = {
    run: jest.fn((fn: () => Promise<unknown>) => fn()),
    getClient: jest.fn(),
    isInTransaction: jest.fn(() => false),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SymbolStore,
        PrismaCodeIntelRepository,
        { provide: PrismaService, useValue: { client: mockPrismaClient } },
        { provide: TRANSACTION_MANAGER, useValue: mockTxManager },
      ],
    }).compile();

    store = module.get<SymbolStore>(SymbolStore);
    prismaService = module.get(PrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('AC-1: upsertSymbol stores symbol metadata', () => {
    it('should store symbol with all metadata fields', async () => {
      const symbol = {
        id: 'proj-123:repo-123:src/auth.ts::authenticate',
        symbolId: 'proj-123:repo-123:src/auth.ts::authenticate',
        projectId: 'proj-123',
        repoId: 'repo-123',
        commitHash: 'abc123',
        name: 'authenticate',
        kind: 'function' as const,
        file: 'src/auth.ts',
        startLine: 1,
        endLine: 1,
        signature: '(userId: string): boolean',
        callers: ['login'],
        callees: [],
        docComment: 'Authenticates a user',
      };

      mockPrismaClient.symbol.upsert.mockResolvedValue(symbol);

      const result = await store.upsertSymbol(symbol);

      expect(result).toEqual(symbol);
      expect(mockPrismaClient.symbol.upsert).toHaveBeenCalledWith({
        where: { projectId_symbolId: { projectId: symbol.projectId, symbolId: symbol.symbolId } },
        create: symbol,
        update: {
          repoId: symbol.repoId,
          commitHash: symbol.commitHash,
          name: symbol.name,
          kind: symbol.kind,
          file: symbol.file,
          startLine: symbol.startLine,
          endLine: symbol.endLine,
          signature: symbol.signature,
          callers: symbol.callers,
          callees: symbol.callees,
          docComment: symbol.docComment,
        },
      });
    });
  });

  describe('AC-2: symbolId convention {projectId}:{repoId}:{filePath}::{SymbolName}', () => {
    it('should create symbol id using the convention', async () => {
      const symbol = {
        id: 'proj-123:repo-abc:src/services/user.ts::UserService',
        symbolId: 'proj-123:repo-abc:src/services/user.ts::UserService',
        projectId: 'proj-123',
        repoId: 'repo-abc',
        commitHash: 'def456',
        name: 'UserService',
        kind: 'class' as const,
        file: 'src/services/user.ts',
        startLine: 1,
        endLine: 10,
        signature: undefined,
        callers: [],
        callees: [],
        docComment: undefined,
      };

      mockPrismaClient.symbol.upsert.mockResolvedValue(symbol);

      await store.upsertSymbol(symbol);

      const upsertCall = mockPrismaClient.symbol.upsert.mock.calls[0][0];
      expect(upsertCall.where).toEqual({
        projectId_symbolId: { projectId: 'proj-123', symbolId: 'proj-123:repo-abc:src/services/user.ts::UserService' },
      });
      expect(upsertCall.create.id).toBe('proj-123:repo-abc:src/services/user.ts::UserService');
      // M13: the row is keyed by (projectId, symbolId), so the update payload
      // refreshes metadata but never rewrites the id.
      expect(upsertCall.update.id).toBeUndefined();
    });

    it('should handle overloaded symbols with # suffix', async () => {
      const symbol = {
        id: 'proj-123:repo:src/overload.ts::doSomething#2',
        symbolId: 'proj-123:repo:src/overload.ts::doSomething#2',
        projectId: 'proj-123',
        repoId: 'repo',
        commitHash: 'over123',
        name: 'doSomething',
        kind: 'function' as const,
        file: 'src/overload.ts',
        startLine: 10,
        endLine: 15,
        signature: '(value: number): number',
        callers: [],
        callees: [],
        docComment: undefined,
      };

      mockPrismaClient.symbol.upsert.mockResolvedValue(symbol);

      await store.upsertSymbol(symbol);

      const upsertCall = mockPrismaClient.symbol.upsert.mock.calls[0][0];
      expect(upsertCall.create.id).toContain('#2');
    });
  });

  describe('AC-3: findCallers returns symbols with symbolId in callers list', () => {
    it('should find all symbols that call the given symbol', async () => {
      const projectId = 'proj-123';
      const symbolId = 'proj-123:repo:src/auth.ts::authenticate';
      const callers = [
        { symbolId: 'proj-123:repo:src/login.ts::login', file: 'src/login.ts', name: 'login', kind: 'function' },
        { symbolId: 'proj-123:repo:src/verify.ts::verify', file: 'src/verify.ts', name: 'verify', kind: 'method' },
      ];

      mockPrismaClient.symbol.findUnique.mockResolvedValue({
        id: symbolId,
        symbolId,
        projectId,
        repoId: 'repo',
        commitHash: 'abc',
        name: 'authenticate',
        kind: 'function',
        file: 'src/auth.ts',
        startLine: 1,
        endLine: 1,
        signature: undefined,
        callers: callers.map((c) => c.symbolId),
        callees: [],
        docComment: undefined,
      });
      mockPrismaClient.symbol.findMany.mockResolvedValue(callers);

      const result = await store.findCallers(projectId, symbolId);

      expect(result).toHaveLength(2);
      expect(result[0].symbolId).toBe('proj-123:repo:src/login.ts::login');
      expect(result[1].symbolId).toBe('proj-123:repo:src/verify.ts::verify');
    });
  });

  describe('AC-4: findCallees returns symbols in given symbol callees list', () => {
    it('should find all symbols called by the given symbol', async () => {
      const projectId = 'proj-123';
      const symbolId = 'login';
      const callees = [
        { symbolId: 'authenticate', file: 'src/auth.ts', name: 'authenticate', kind: 'function' as const },
        { symbolId: 'loadUser', file: 'src/user.ts', name: 'loadUser', kind: 'function' as const },
      ];

      mockPrismaClient.symbol.findUnique.mockResolvedValue({
        id: `proj-123:repo:src/login.ts::login`,
        symbolId: 'login',
        projectId,
        repoId: 'repo',
        commitHash: 'abc',
        name: 'login',
        kind: 'function',
        file: 'src/login.ts',
        startLine: 1,
        endLine: 1,
        signature: undefined,
        callers: [],
        callees: ['authenticate', 'loadUser'],
        docComment: undefined,
      });

      mockPrismaClient.symbol.findMany.mockResolvedValue([
        {
          id: `proj-123:repo:src/auth.ts::authenticate`,
          symbolId: 'authenticate',
          projectId,
          repoId: 'repo',
          commitHash: 'abc',
          name: 'authenticate',
          kind: 'function',
          file: 'src/auth.ts',
          startLine: 1,
          endLine: 1,
          signature: undefined,
          callers: [],
          callees: [],
          docComment: undefined,
        },
        {
          id: `proj-123:repo:src/user.ts::loadUser`,
          symbolId: 'loadUser',
          projectId,
          repoId: 'repo',
          commitHash: 'abc',
          name: 'loadUser',
          kind: 'function',
          file: 'src/user.ts',
          startLine: 1,
          endLine: 1,
          signature: undefined,
          callers: [],
          callees: [],
          docComment: undefined,
        },
      ]);

      const result = await store.findCallees(projectId, symbolId);

      expect(result).toHaveLength(2);
    });
  });

  describe('AC-5: existing symbols for unchanged files are preserved', () => {
    it('should not delete symbols for files not in the commit', async () => {
      const projectId = 'proj-123';
      const repoId = 'repo-123';
      const commitHash = 'newcommit';

      await store.upsertSymbol({
        id: `${projectId}:${repoId}:src/new.ts::newFunc`,
        symbolId: 'newFunc',
        projectId,
        repoId,
        commitHash,
        name: 'newFunc',
        kind: 'function',
        file: 'src/new.ts',
        startLine: 1,
        endLine: 1,
        signature: undefined,
        callers: [],
        callees: [],
        docComment: undefined,
      });

      expect(mockPrismaClient.symbol.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('BUG-3: findCallers should read the target symbol caller list directly', () => {
    it('should load only symbols referenced by the target symbol caller list', async () => {
      const projectId = 'proj-bug3';
      const symbolId = 'proj-bug3:repo:src/target.ts::targetSymbol';
      const callerId = 'proj-bug3:repo:src/caller.ts::callerSymbol';

      mockPrismaClient.symbol.findUnique.mockResolvedValue({
        id: symbolId,
        symbolId,
        projectId,
        repoId: 'repo',
        commitHash: 'abc',
        name: 'targetSymbol',
        kind: 'function',
        file: 'src/target.ts',
        startLine: 1,
        endLine: 1,
        signature: undefined,
        callers: [callerId],
        callees: [],
        docComment: undefined,
      });
      mockPrismaClient.symbol.findMany.mockResolvedValue([
        { symbolId: callerId, file: 'src/caller.ts', name: 'callerSymbol', kind: 'function' },
      ]);

      await store.findCallers(projectId, symbolId);

      expect(mockPrismaClient.$queryRawUnsafe).not.toHaveBeenCalled();
      expect(mockPrismaClient.symbol.findMany).toHaveBeenCalledWith({
        where: {
          projectId,
          symbolId: { in: [callerId] },
        },
      });
    });
  });

  describe('BUG-4: findCallees should resolve callees by name when symbolId formats differ', () => {
    it('should match callees by unqualified name when DB stores qualified symbolIds', async () => {
      const projectId = 'proj-bug4';
      const symbolId = 'main';

      const mainSymbol = {
        id: 'proj-bug4:repo:src/main.ts::main',
        symbolId: 'main',
        projectId,
        repoId: 'repo',
        commitHash: 'abc',
        name: 'main',
        kind: 'function' as const,
        file: 'src/main.ts',
        startLine: 1,
        endLine: 10,
        signature: undefined,
        callers: [],
        callees: ['UserService.authenticate', 'UserService.getUser'],
        docComment: undefined,
      };

      const calleeSymbols = [
        {
          id: 'proj-bug4:repo:src/auth.ts::UserService.authenticate',
          symbolId: 'UserService.authenticate',
          projectId,
          repoId: 'repo',
          commitHash: 'abc',
          name: 'UserService.authenticate',
          kind: 'method' as const,
          file: 'src/auth.ts',
          startLine: 5,
          endLine: 7,
          signature: '(token: string): Promise<User>',
          callers: [],
          callees: [],
          docComment: undefined,
        },
        {
          id: 'proj-bug4:repo:src/user.ts::UserService.getUser',
          symbolId: 'UserService.getUser',
          projectId,
          repoId: 'repo',
          commitHash: 'abc',
          name: 'UserService.getUser',
          kind: 'method' as const,
          file: 'src/user.ts',
          startLine: 3,
          endLine: 5,
          signature: '(id: string): Promise<User>',
          callers: [],
          callees: [],
          docComment: undefined,
        },
      ];

      mockPrismaClient.symbol.findUnique.mockResolvedValue(mainSymbol);
      mockPrismaClient.symbol.findMany.mockImplementation((args: Record<string, unknown>) => {
        const where = args.where as { OR?: Array<{ symbolId?: { in: string[] }; name?: { in: string[] } }> };
        const symbolIds = where.OR?.flatMap((clause) => clause.symbolId?.in ?? []) ?? [];
        const names = where.OR?.flatMap((clause) => clause.name?.in ?? []) ?? [];
        const matched = calleeSymbols.filter((s) => symbolIds.includes(s.symbolId) || names.includes(s.name));
        return Promise.resolve(matched);
      });

      const result = await store.findCallees(projectId, symbolId);

      expect(result).toHaveLength(2);
      const resultSymbolIds = result.map((c) => c.symbolId);
      expect(resultSymbolIds).toContain('UserService.authenticate');
      expect(resultSymbolIds).toContain('UserService.getUser');
    });
  });

  describe('BUG-5: indexCommit atomicity — SymbolStore should use transaction manager', () => {
    it('should execute upsertSymbol within txManager.run for transactional safety', async () => {
      const symbol = {
        id: 'repo:src/auth.ts::authenticate',
        symbolId: 'authenticate',
        projectId: 'proj-tx',
        repoId: 'repo-tx',
        commitHash: 'tx123',
        name: 'authenticate',
        kind: 'function' as const,
        file: 'src/auth.ts',
        startLine: 1,
        endLine: 1,
        signature: '(userId: string): boolean',
        callers: [],
        callees: [],
        docComment: undefined,
      };

      mockPrismaClient.symbol.upsert.mockResolvedValue(symbol);

      await store.upsertSymbol(symbol);

      expect(mockTxManager.run).toHaveBeenCalled();
    });
  });
});
