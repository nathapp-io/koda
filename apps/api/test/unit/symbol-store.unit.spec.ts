import { Test, TestingModule } from '@nestjs/testing';
import { SymbolStore } from '../../src/code-intel/symbol-store';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '@prisma/client';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';

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
        id: 'repo:src/auth.ts::authenticate',
        symbolId: 'authenticate',
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
        where: { id: symbol.id },
        create: symbol,
        update: symbol,
      });
    });
  });

  describe('AC-2: symbolId convention {repoId}:{filePath}::{SymbolName}', () => {
    it('should create symbol id using the convention', async () => {
      const symbol = {
        id: 'repo-abc:src/services/user.ts::UserService',
        symbolId: 'UserService',
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
      expect(upsertCall.create.id).toBe('repo-abc:src/services/user.ts::UserService');
      expect(upsertCall.update.id).toBe('repo-abc:src/services/user.ts::UserService');
    });

    it('should handle overloaded symbols with # suffix', async () => {
      const symbol = {
        id: 'repo:src/overload.ts::doSomething#2',
        symbolId: 'doSomething#2',
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
      const symbolId = 'authenticate';
      const callers = [
        { symbolId: 'login', file: 'src/login.ts', name: 'login', kind: 'function' as const },
        { symbolId: 'verify', file: 'src/verify.ts', name: 'verify', kind: 'method' as const },
      ];

      mockPrismaClient.symbol.findMany.mockResolvedValue([
        {
          id: `repo:src/login.ts::login`,
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
          callers: [symbolId],
          callees: [],
          docComment: undefined,
        },
        {
          id: `repo:src/verify.ts::verify`,
          symbolId: 'verify',
          projectId,
          repoId: 'repo',
          commitHash: 'abc',
          name: 'verify',
          kind: 'method',
          file: 'src/verify.ts',
          startLine: 1,
          endLine: 1,
          signature: undefined,
          callers: [symbolId],
          callees: [],
          docComment: undefined,
        },
      ]);

      const result = await store.findCallers(projectId, symbolId);

      expect(result).toHaveLength(2);
      expect(result[0].symbolId).toBe('login');
      expect(result[1].symbolId).toBe('verify');
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
        id: `repo:src/login.ts::login`,
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
          id: `repo:src/auth.ts::authenticate`,
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
          id: `repo:src/user.ts::loadUser`,
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
      const files = [{ path: 'src/new.ts', content: 'export function newFunc() {}' }];

      await store.upsertSymbol({
        id: `${repoId}:src/new.ts::newFunc`,
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

  describe('BUG-3: findCallers should use filtered DB query instead of loading all project symbols', () => {
    it('should query DB with callers filter rather than loading all symbols and filtering in memory', async () => {
      const projectId = 'proj-bug3';
      const symbolId = 'targetSymbol';

      mockPrismaClient.symbol.findMany.mockResolvedValue([]);

      await store.findCallers(projectId, symbolId);

      const findManyArgs = mockPrismaClient.symbol.findMany.mock.calls[0][0];
      const whereKeys = Object.keys(findManyArgs.where || {});
      expect(whereKeys.length).toBeGreaterThan(1);
      expect(findManyArgs.where).toHaveProperty('projectId');
    });
  });

  describe('BUG-4: findCallees should resolve callees by name when symbolId formats differ', () => {
    it('should match callees by unqualified name when DB stores qualified symbolIds', async () => {
      const projectId = 'proj-bug4';
      const symbolId = 'main';

      const mainSymbol = {
        id: 'repo:src/main.ts::main',
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
        callees: ['authenticate', 'getUser'],
        docComment: undefined,
      };

      const calleeSymbols = [
        {
          id: 'repo:src/auth.ts::UserService.authenticate',
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
          id: 'repo:src/user.ts::UserService.getUser',
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
        const where = args.where as { symbolId?: { in: string[] } };
        const calleeIds = where?.symbolId?.in || [];
        const matched = calleeSymbols.filter((s) => calleeIds.includes(s.symbolId));
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
