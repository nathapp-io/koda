import { createMock } from '@golevelup/ts-jest';
import { ITransactionManager } from '@nathapp/nestjs-data';
import { AstIndexService, SourceFile } from './ast-index.service';
import { CodeGraphService, ExtractedSymbol, ParsedSourceFile, ResolvedSymbol } from './code-graph.service';
import { SymbolStore, SymbolData, CallerInfo, CalleeInfo } from './symbol-store';

function buildExtractedSymbol(overrides: Partial<ExtractedSymbol> = {}): ExtractedSymbol {
  return {
    name: 'MySymbol',
    kind: 'function',
    file: 'src/a.ts',
    startLine: 1,
    endLine: 5,
    callers: [],
    callees: [],
    ...overrides,
  };
}

function buildSymbolData(overrides: Partial<SymbolData> = {}): SymbolData {
  return {
    id: 'repo-1:src/a.ts::MySymbol',
    symbolId: 'repo-1:src/a.ts::MySymbol',
    projectId: 'proj-1',
    repoId: 'repo-1',
    commitHash: 'abc123',
    name: 'MySymbol',
    kind: 'function',
    file: 'src/a.ts',
    startLine: 1,
    endLine: 5,
    callers: [],
    callees: [],
    ...overrides,
  };
}

describe('AstIndexService', () => {
  let service: AstIndexService;
  let codeGraph: jest.Mocked<CodeGraphService>;
  let symbolStore: jest.Mocked<SymbolStore>;
  let txManager: jest.Mocked<ITransactionManager>;

  beforeEach(() => {
    codeGraph = createMock<CodeGraphService>();
    symbolStore = createMock<SymbolStore>();
    txManager = createMock<ITransactionManager>();

    // Default: txManager.run executes the callback immediately
    txManager.run.mockImplementation((fn) => fn());

    service = new AstIndexService(codeGraph, symbolStore, txManager);
  });

  describe('indexCommit()', () => {
    it('returns a result with zero symbols when file list is empty', async () => {
      const result = await service.indexCommit('repo-1', 'abc123', [], 'proj-1');

      expect(result.commitHash).toBe('abc123');
      expect(result.symbolsIndexed).toBe(0);
      expect(result.filesIndexed).toBe(0);
      expect(result.fileErrors).toHaveLength(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('happy path: parses files, assigns ids, calls symbolStore.upsertSymbol', async () => {
      const files: SourceFile[] = [{ path: 'src/a.ts', content: 'const x = 1;' }];
      const extracted: ExtractedSymbol = buildExtractedSymbol();
      const fakeParsed = {} as ParsedSourceFile;

      codeGraph.parseSourceFile.mockReturnValue(fakeParsed);
      codeGraph.extractSymbols.mockReturnValue([extracted]);
      codeGraph.resolveRelationships.mockReturnValue(undefined);
      symbolStore.upsertSymbol.mockResolvedValue(buildSymbolData());

      const result = await service.indexCommit('repo-1', 'abc123', files, 'proj-1');

      expect(codeGraph.parseSourceFile).toHaveBeenCalledWith('src/a.ts', 'const x = 1;');
      expect(codeGraph.extractSymbols).toHaveBeenCalledWith(fakeParsed);
      expect(codeGraph.resolveRelationships).toHaveBeenCalled();
      expect(symbolStore.upsertSymbol).toHaveBeenCalledTimes(1);
      expect(result.filesIndexed).toBe(1);
      expect(result.symbolsIndexed).toBe(1);
      expect(result.fileErrors).toHaveLength(0);
    });

    it('records a fileError and skips symbol upsert when parseSourceFile throws', async () => {
      const files: SourceFile[] = [{ path: 'src/bad.ts', content: 'invalid' }];

      codeGraph.parseSourceFile.mockImplementation(() => {
        throw new Error('parse failed');
      });
      codeGraph.resolveRelationships.mockReturnValue(undefined);

      const result = await service.indexCommit('repo-1', 'abc123', files, 'proj-1');

      expect(result.filesIndexed).toBe(0);
      expect(result.symbolsIndexed).toBe(0);
      expect(result.fileErrors).toHaveLength(1);
      expect(result.fileErrors[0].path).toBe('src/bad.ts');
      expect(result.fileErrors[0].error).toBe('parse failed');
      expect(symbolStore.upsertSymbol).not.toHaveBeenCalled();
    });

    it('handles non-Error throws during parse gracefully', async () => {
      const files: SourceFile[] = [{ path: 'src/x.ts', content: '' }];

      codeGraph.parseSourceFile.mockImplementation(() => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw 'string error';
      });
      codeGraph.resolveRelationships.mockReturnValue(undefined);

      const result = await service.indexCommit('repo-1', 'abc123', files, 'proj-1');

      expect(result.fileErrors[0].error).toBe('string error');
    });

    it('assigns unique symbolIds for duplicate names within the same file', async () => {
      const files: SourceFile[] = [{ path: 'src/a.ts', content: '' }];
      const sym1: ExtractedSymbol = buildExtractedSymbol({ name: 'myFn', file: 'src/a.ts' });
      const sym2: ExtractedSymbol = buildExtractedSymbol({ name: 'myFn', file: 'src/a.ts' });
      const fakeParsed = {} as ParsedSourceFile;

      codeGraph.parseSourceFile.mockReturnValue(fakeParsed);
      codeGraph.extractSymbols.mockReturnValue([sym1, sym2]);
      codeGraph.resolveRelationships.mockReturnValue(undefined);
      symbolStore.upsertSymbol.mockResolvedValue(buildSymbolData());

      await service.indexCommit('repo-1', 'abc123', files, 'proj-1');

      const calls = symbolStore.upsertSymbol.mock.calls;
      const ids = calls.map((c) => c[0].symbolId);
      // Second occurrence should get a disambiguating suffix
      expect(ids[0]).not.toBe(ids[1]);
    });

    it('builds full symbol id with repoId prefix', async () => {
      const files: SourceFile[] = [{ path: 'src/a.ts', content: '' }];
      const extracted: ExtractedSymbol = buildExtractedSymbol({ name: 'Foo', file: 'src/a.ts' });
      const fakeParsed = {} as ParsedSourceFile;

      codeGraph.parseSourceFile.mockReturnValue(fakeParsed);
      codeGraph.extractSymbols.mockReturnValue([extracted]);
      codeGraph.resolveRelationships.mockReturnValue(undefined);
      symbolStore.upsertSymbol.mockResolvedValue(buildSymbolData());

      await service.indexCommit('my-repo', 'abc123', files, 'proj-1');

      const upsertArg = symbolStore.upsertSymbol.mock.calls[0][0];
      expect(upsertArg.id).toContain('my-repo');
      expect(upsertArg.repoId).toBe('my-repo');
    });

    it('runs upserts inside a transaction', async () => {
      const files: SourceFile[] = [{ path: 'src/a.ts', content: '' }];
      const extracted: ExtractedSymbol = buildExtractedSymbol();
      const fakeParsed = {} as ParsedSourceFile;

      codeGraph.parseSourceFile.mockReturnValue(fakeParsed);
      codeGraph.extractSymbols.mockReturnValue([extracted]);
      codeGraph.resolveRelationships.mockReturnValue(undefined);
      symbolStore.upsertSymbol.mockResolvedValue(buildSymbolData());

      await service.indexCommit('repo-1', 'abc123', files, 'proj-1');

      expect(txManager.run).toHaveBeenCalledTimes(1);
    });

    it('processes multiple files independently, recording per-file errors', async () => {
      const files: SourceFile[] = [
        { path: 'src/ok.ts', content: 'function ok() {}' },
        { path: 'src/bad.ts', content: 'broken' },
      ];
      const fakeParsed = {} as ParsedSourceFile;
      const extracted: ExtractedSymbol = buildExtractedSymbol({ name: 'ok', file: 'src/ok.ts' });

      codeGraph.parseSourceFile
        .mockReturnValueOnce(fakeParsed)
        .mockImplementationOnce(() => { throw new Error('syntax error'); });
      codeGraph.extractSymbols.mockReturnValue([extracted]);
      codeGraph.resolveRelationships.mockReturnValue(undefined);
      symbolStore.upsertSymbol.mockResolvedValue(buildSymbolData());

      const result = await service.indexCommit('repo-1', 'abc123', files, 'proj-1');

      expect(result.filesIndexed).toBe(1);
      expect(result.fileErrors).toHaveLength(1);
      expect(result.fileErrors[0].path).toBe('src/bad.ts');
    });
  });

  describe('getSymbol()', () => {
    it('returns null when symbolStore has no record', async () => {
      symbolStore.findBySymbolId.mockResolvedValue(null);
      const result = await service.getSymbol('proj-1', 'nonexistent');
      expect(result).toBeNull();
    });

    it('maps SymbolData to Symbol domain object', async () => {
      const data = buildSymbolData({ signature: '(): void', docComment: 'doc' });
      symbolStore.findBySymbolId.mockResolvedValue(data);

      const result = await service.getSymbol('proj-1', 'MySymbol');

      expect(result).not.toBeNull();
      expect(result?.name).toBe('MySymbol');
      expect(result?.signature).toBe('(): void');
      expect(result?.docComment).toBe('doc');
      expect(result?.projectId).toBe('proj-1');
    });
  });

  describe('getCallers()', () => {
    it('delegates to symbolStore.findCallers', async () => {
      const callers: CallerInfo[] = [{ symbolId: 'a', file: 'src/a.ts', name: 'a', kind: 'function' }];
      symbolStore.findCallers.mockResolvedValue(callers);

      const result = await service.getCallers('proj-1', 'MySymbol');

      expect(symbolStore.findCallers).toHaveBeenCalledWith('proj-1', 'MySymbol');
      expect(result).toEqual(callers);
    });

    it('returns empty array when no callers found', async () => {
      symbolStore.findCallers.mockResolvedValue([]);
      const result = await service.getCallers('proj-1', 'MySymbol');
      expect(result).toHaveLength(0);
    });
  });

  describe('getCallees()', () => {
    it('delegates to symbolStore.findCallees', async () => {
      const callees: CalleeInfo[] = [{ symbolId: 'b', file: 'src/b.ts', name: 'b', kind: 'function' }];
      symbolStore.findCallees.mockResolvedValue(callees);

      const result = await service.getCallees('proj-1', 'MySymbol');

      expect(symbolStore.findCallees).toHaveBeenCalledWith('proj-1', 'MySymbol');
      expect(result).toEqual(callees);
    });

    it('returns empty array when no callees found', async () => {
      symbolStore.findCallees.mockResolvedValue([]);
      const result = await service.getCallees('proj-1', 'MySymbol');
      expect(result).toHaveLength(0);
    });
  });
});
