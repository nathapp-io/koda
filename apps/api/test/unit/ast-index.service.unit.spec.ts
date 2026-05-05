import { Test, TestingModule } from '@nestjs/testing';
import { AstIndexService, SymbolIndexResult, CallerInfo, CalleeInfo } from '../../src/code-intel/ast-index.service';
import { SymbolStore } from '../../src/code-intel/symbol-store';
import { CodeGraphService } from '../../src/code-intel/code-graph.service';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';

describe('AstIndexService', () => {
  let service: AstIndexService;
  let symbolStore: jest.Mocked<SymbolStore>;
  let codeGraph: jest.Mocked<CodeGraphService>;

  const mockTxManager = {
    run: jest.fn((fn: () => Promise<unknown>) => fn()),
    getClient: jest.fn(),
    isInTransaction: jest.fn(() => false),
  };

  const mockCodeGraph = {
    parseSourceFile: jest.fn(),
    extractSymbols: jest.fn(),
    extractCallers: jest.fn(),
    extractCallees: jest.fn(),
    resolveRelationships: jest.fn(),
  };

  const mockSymbolStore = {
    upsertSymbol: jest.fn(),
    findBySymbolId: jest.fn(),
    findCallers: jest.fn(),
    findCallees: jest.fn(),
    deleteByFile: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AstIndexService,
        { provide: SymbolStore, useValue: mockSymbolStore },
        { provide: CodeGraphService, useValue: mockCodeGraph },
        { provide: TRANSACTION_MANAGER, useValue: mockTxManager },
      ],
    }).compile();

    service = module.get<AstIndexService>(AstIndexService);
    symbolStore = module.get(SymbolStore);
    codeGraph = module.get(CodeGraphService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('indexCommit', () => {
    it('AC-1: should parse source files and store symbol metadata in Symbol table', async () => {
      const repoId = 'repo-123';
      const commitHash = 'abc123';
      const projectId = 'proj-123';
      const files = [
        { path: 'src/auth.ts', content: 'export function authenticate(userId: string) { return true; }' },
      ];

      const mockSymbols = [
        {
          name: 'authenticate',
          kind: 'function' as const,
          file: 'src/auth.ts',
          startLine: 1,
          endLine: 1,
          signature: '(userId: string): boolean',
          callers: [],
          callees: [],
          docComment: undefined,
        },
      ];

      mockCodeGraph.parseSourceFile.mockReturnValue({
        path: 'src/auth.ts',
        content: files[0].content,
        ast: {},
      });
      mockCodeGraph.extractSymbols.mockReturnValue(mockSymbols);
      mockCodeGraph.resolveRelationships.mockImplementation((syms: Array<{ callers: string[]; callees: string[] }>) => {
        for (const s of syms) { s.callers = []; s.callees = []; }
      });
      mockSymbolStore.upsertSymbol.mockResolvedValue(undefined as never);

      const result = await service.indexCommit(repoId, commitHash, files, projectId);

      expect(result.commitHash).toBe(commitHash);
      expect(result.symbolsIndexed).toBe(1);
      expect(result.filesIndexed).toBe(1);
      expect(result.fileErrors).toHaveLength(0);
      expect(mockSymbolStore.upsertSymbol).toHaveBeenCalledTimes(1);
    });

    it('AC-2: Symbol.symbolId should use convention {repoId}:{filePath}::{SymbolName}', async () => {
      const repoId = 'repo-456';
      const commitHash = 'def456';
      const projectId = 'proj-789';
      const files = [
        { path: 'src/services/user.ts', content: 'export class UserService { getUser(id: string) {} }' },
      ];

      const mockSymbols = [
        {
          name: 'UserService',
          kind: 'class' as const,
          file: 'src/services/user.ts',
          startLine: 1,
          endLine: 1,
          signature: undefined,
          callers: [],
          callees: [],
          docComment: undefined,
        },
      ];

      mockCodeGraph.parseSourceFile.mockReturnValue({
        path: 'src/services/user.ts',
        content: files[0].content,
        ast: {},
      });
      mockCodeGraph.extractSymbols.mockReturnValue(mockSymbols);
      mockCodeGraph.resolveRelationships.mockImplementation((syms: Array<{ callers: string[]; callees: string[] }>) => {
        for (const s of syms) { s.callers = []; s.callees = []; }
      });
      mockSymbolStore.upsertSymbol.mockResolvedValue(undefined as never);

      const result = await service.indexCommit(repoId, commitHash, files, projectId);

      const storedSymbol = mockSymbolStore.upsertSymbol.mock.calls[0][0];
      expect(storedSymbol.id).toBe(`${repoId}:src/services/user.ts::UserService`);
      expect(storedSymbol.symbolId).toBe('UserService');
      expect(result.symbolsIndexed).toBe(1);
    });

    it('AC-5: only the specified file should be parsed when files=[{path: src/auth.ts}]', async () => {
      const repoId = 'repo-123';
      const commitHash = 'abc123';
      const projectId = 'proj-123';
      const files = [
        { path: 'src/auth.ts', content: 'export function authenticate() {}' },
      ];

      mockCodeGraph.parseSourceFile.mockReturnValue({
        path: 'src/auth.ts',
        content: files[0].content,
        ast: {},
      });
      mockCodeGraph.extractSymbols.mockReturnValue([]);

      await service.indexCommit(repoId, commitHash, files, projectId);

      expect(mockCodeGraph.parseSourceFile).toHaveBeenCalledTimes(1);
      expect(mockCodeGraph.parseSourceFile).toHaveBeenCalledWith('src/auth.ts', files[0].content);
    });

    it('AC-6: Symbol.signature should capture parameter types and return type', async () => {
      const repoId = 'repo-123';
      const commitHash = 'abc123';
      const projectId = 'proj-123';
      const files = [
        {
          path: 'src/user.ts',
          content: 'export async function getUser(userId: string): Promise<User> { return {} as User; }',
        },
      ];

      const mockSymbols = [
        {
          name: 'getUser',
          kind: 'function' as const,
          file: 'src/user.ts',
          startLine: 1,
          endLine: 1,
          signature: '(userId: string): Promise<User>',
          callers: [],
          callees: [],
          docComment: undefined,
        },
      ];

      mockCodeGraph.parseSourceFile.mockReturnValue({
        path: 'src/user.ts',
        content: files[0].content,
        ast: {},
      });
      mockCodeGraph.extractSymbols.mockReturnValue(mockSymbols);
      mockCodeGraph.resolveRelationships.mockImplementation((syms: Array<{ callers: string[]; callees: string[] }>) => {
        for (const s of syms) { s.callers = []; s.callees = []; }
      });
      mockSymbolStore.upsertSymbol.mockResolvedValue(undefined as never);

      await service.indexCommit(repoId, commitHash, files, projectId);

      const storedSymbol = mockSymbolStore.upsertSymbol.mock.calls[0][0];
      expect(storedSymbol.signature).toBe('(userId: string): Promise<User>');
    });

    it('AC-8: a commit with 20 files (average 200 lines each) should be indexed in under 30 seconds', async () => {
      const repoId = 'repo-performance';
      const commitHash = 'perf123';
      const projectId = 'proj-perf';
      const files = Array.from({ length: 20 }, (_, i) => ({
        path: `src/file${i}.ts`,
        content: `export function func${i}(param: string): number { return 42; }\n`.repeat(50),
      }));

      mockCodeGraph.parseSourceFile.mockImplementation((path, content) => ({
        path,
        content,
        ast: {},
      }));
      mockCodeGraph.extractSymbols.mockReturnValue([]);

      const startTime = Date.now();
      const result = await service.indexCommit(repoId, commitHash, files, projectId);
      const durationMs = Date.now() - startTime;

      expect(result.durationMs).toBeLessThan(30000);
      expect(result.filesIndexed).toBe(20);
    });

    it('AC-10: parser failures for one file should be recorded in fileErrors and not prevent other files from being indexed', async () => {
      const repoId = 'repo-error';
      const commitHash = 'err123';
      const projectId = 'proj-err';
      const files = [
        { path: 'src/good.ts', content: 'export function hello() {}' },
        { path: 'src/bad.ts', content: 'invalid syntax {{{' },
        { path: 'src/also-good.ts', content: 'export function world() {}' },
      ];

      mockCodeGraph.parseSourceFile.mockImplementation((path) => {
        if (path === 'src/bad.ts') {
          throw new Error('Parse error: unexpected token');
        }
        return { path, content: '', ast: {} };
      });
      mockCodeGraph.extractSymbols.mockReturnValue([]);

      const result = await service.indexCommit(repoId, commitHash, files, projectId);

      expect(result.fileErrors).toHaveLength(1);
      expect(result.fileErrors[0].path).toBe('src/bad.ts');
      expect(result.fileErrors[0].error).toContain('Parse error');
      expect(result.filesIndexed).toBe(2);
    });
  });

  describe('getSymbol', () => {
    it('should return symbol by projectId and symbolId', async () => {
      const projectId = 'proj-123';
      const symbolId = 'authenticate';
      const mockSymbol = {
        id: `repo:src/auth.ts::${symbolId}`,
        symbolId,
        projectId,
        repoId: 'repo',
        commitHash: 'abc',
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

      mockSymbolStore.findBySymbolId.mockResolvedValue(mockSymbol);

      const result = await service.getSymbol(projectId, symbolId);

      expect(result).toEqual(mockSymbol);
      expect(mockSymbolStore.findBySymbolId).toHaveBeenCalledWith(projectId, symbolId);
    });

    it('should return null when symbol not found', async () => {
      mockSymbolStore.findBySymbolId.mockResolvedValue(null);

      const result = await service.getSymbol('proj-123', 'nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('getCallers', () => {
    it('AC-3: should return all symbols that include the given symbolId in their callers list', async () => {
      const projectId = 'proj-123';
      const symbolId = 'authenticate';
      const mockCallers: CallerInfo[] = [
        { symbolId: 'login', file: 'src/login.ts', name: 'login', kind: 'function' },
        { symbolId: 'verify', file: 'src/verify.ts', name: 'verify', kind: 'method' },
      ];

      mockSymbolStore.findCallers.mockResolvedValue(mockCallers);

      const result = await service.getCallers(projectId, symbolId);

      expect(result).toEqual(mockCallers);
      expect(mockSymbolStore.findCallers).toHaveBeenCalledWith(projectId, symbolId);
    });
  });

  describe('getCallees', () => {
    it('AC-4: should return all symbols listed in the given symbol callees list', async () => {
      const projectId = 'proj-123';
      const symbolId = 'login';
      const mockCallees: CalleeInfo[] = [
        { symbolId: 'authenticate', file: 'src/auth.ts', name: 'authenticate', kind: 'function' },
        { symbolId: 'loadUser', file: 'src/user.ts', name: 'loadUser', kind: 'function' },
      ];

      mockSymbolStore.findCallees.mockResolvedValue(mockCallees);

      const result = await service.getCallees(projectId, symbolId);

      expect(result).toEqual(mockCallees);
      expect(mockSymbolStore.findCallees).toHaveBeenCalledWith(projectId, symbolId);
    });
  });

  describe('BUG-1: enrichSymbol() collision suffix', () => {
    it('should append #N suffix to symbolIds when multiple symbols share the same name in the same file', async () => {
      const repoId = 'repo-collision';
      const commitHash = 'col123';
      const projectId = 'proj-col';
      const files = [
        { path: 'src/overload.ts', content: 'function doSomething(a: string) {} function doSomething(a: number) {}' },
      ];

      const mockSymbols = [
        {
          name: 'doSomething',
          kind: 'function' as const,
          file: 'src/overload.ts',
          startLine: 1,
          endLine: 1,
          signature: '(a: string): void',
          callers: [],
          callees: [],
          docComment: undefined,
        },
        {
          name: 'doSomething',
          kind: 'function' as const,
          file: 'src/overload.ts',
          startLine: 2,
          endLine: 2,
          signature: '(a: number): void',
          callers: [],
          callees: [],
          docComment: undefined,
        },
      ];

      mockCodeGraph.parseSourceFile.mockReturnValue({
        path: 'src/overload.ts',
        content: files[0].content,
        ast: {},
      });
      mockCodeGraph.extractSymbols.mockReturnValue(mockSymbols);
      mockCodeGraph.resolveRelationships.mockImplementation((syms: Array<{ callers: string[]; callees: string[] }>) => {
        for (const s of syms) { s.callers = []; s.callees = []; }
      });
      mockSymbolStore.upsertSymbol.mockResolvedValue(undefined as never);

      await service.indexCommit(repoId, commitHash, files, projectId);

      expect(mockSymbolStore.upsertSymbol).toHaveBeenCalledTimes(2);
      const firstCall = mockSymbolStore.upsertSymbol.mock.calls[0][0];
      const secondCall = mockSymbolStore.upsertSymbol.mock.calls[1][0];
      expect(firstCall.symbolId).toBe('doSomething');
      expect(secondCall.symbolId).toMatch(/^doSomething#\d+$/);
      expect(firstCall.id).toBe(`${repoId}:src/overload.ts::doSomething`);
      expect(secondCall.id).toMatch(new RegExp(`^${repoId}:src/overload\\.ts::doSomething#\\d+$`));
    });
  });

  describe('BUG-5: indexCommit should use batch operation for atomicity', () => {
    it('should propagate upsert failures without leaving prior writes committed', async () => {
      const repoId = 'repo-tx';
      const commitHash = 'tx123';
      const projectId = 'proj-tx';
      const files = [
        { path: 'src/a.ts', content: 'function a() {}' },
        { path: 'src/b.ts', content: 'function b() {}' },
      ];

      const symA = {
        name: 'a',
        kind: 'function' as const,
        file: 'src/a.ts',
        startLine: 1,
        endLine: 1,
        signature: '(): void',
        callers: [],
        callees: [],
        docComment: undefined,
      };
      const symB = {
        name: 'b',
        kind: 'function' as const,
        file: 'src/b.ts',
        startLine: 1,
        endLine: 1,
        signature: '(): void',
        callers: [],
        callees: [],
        docComment: undefined,
      };

      mockCodeGraph.parseSourceFile.mockImplementation((path: string, content: string) => ({
        path,
        content,
        ast: {},
      }));
      mockCodeGraph.extractSymbols.mockImplementation((parsed: { path: string }) => {
        if (parsed.path === 'src/a.ts') return [symA];
        if (parsed.path === 'src/b.ts') return [symB];
        return [];
      });
      mockCodeGraph.resolveRelationships.mockImplementation((syms: Array<{ callers: string[]; callees: string[] }>) => {
        for (const s of syms) { s.callers = []; s.callees = []; }
      });

      let upsertCallCount = 0;
      mockSymbolStore.upsertSymbol.mockImplementation(async () => {
        upsertCallCount++;
        if (upsertCallCount === 2) throw new Error('Simulated DB failure mid-batch');
        return undefined as never;
      });

      await expect(service.indexCommit(repoId, commitHash, files, projectId)).rejects.toThrow(
        'Simulated DB failure mid-batch',
      );

      expect(mockSymbolStore.upsertSymbol).toHaveBeenCalledTimes(2);
      expect(mockTxManager.run).toHaveBeenCalled();
    });
  });
});
