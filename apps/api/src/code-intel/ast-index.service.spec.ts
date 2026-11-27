import type { Mocked } from 'vitest';
import { createMock } from '@golevelup/ts-vitest';
import { ITransactionManager } from '@nathapp/nestjs-data';
import { AstIndexService, SourceFile } from './ast-index.service';
import { CodeGraphService, ExtractedSymbol, ResolvedSymbol } from './code-graph.service';
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
  let codeGraph: Mocked<CodeGraphService>;
  let symbolStore: Mocked<SymbolStore>;
  let txManager: Mocked<ITransactionManager>;

  beforeEach(() => {
    codeGraph = createMock<CodeGraphService>();
    symbolStore = createMock<SymbolStore>();
    txManager = createMock<ITransactionManager>();

    // Default: txManager.run executes the callback immediately
    txManager.run.mockImplementation((fn) => fn());

    service = new AstIndexService(codeGraph, symbolStore, txManager);
  });

  describe('indexCommit()', () => {
    it('calls onIndexed exactly once inside the transaction for nonempty input', async () => {
      const files: SourceFile[] = [{ path: 'src/a.ts', content: 'x' }];
      codeGraph.extractBatch.mockReturnValue([{ path: 'src/a.ts', symbols: [buildExtractedSymbol()] }]);
      let inTransaction = false;
      txManager.run.mockImplementation(async (fn) => {
        inTransaction = true;
        try { return await fn(); } finally { inTransaction = false; }
      });
      const onIndexed = vi.fn(async () => { expect(inTransaction).toBe(true); });
      const result = await service.indexCommit('repo-1', 'abc123', files, 'proj-1', onIndexed);
      expect(onIndexed).toHaveBeenCalledExactlyOnceWith({ symbolsIndexed: result.symbolsIndexed, filesIndexed: result.filesIndexed });
    });

    it('does not call onIndexed for empty input', async () => {
      const onIndexed = vi.fn(async () => undefined);
      await service.indexCommit('repo-1', 'abc123', [], 'proj-1', onIndexed);
      expect(onIndexed).not.toHaveBeenCalled();
    });

    it('returns a result with zero symbols when file list is empty', async () => {
      const result = await service.indexCommit('repo-1', 'abc123', [], 'proj-1');

      expect(result.commitHash).toBe('abc123');
      expect(result.symbolsIndexed).toBe(0);
      expect(result.filesIndexed).toBe(0);
      expect(result.fileErrors).toHaveLength(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('happy path: extracts files, assigns ids, calls symbolStore.upsertSymbol', async () => {
      const files: SourceFile[] = [{ path: 'src/a.ts', content: 'const x = 1;' }];
      const extracted: ExtractedSymbol = buildExtractedSymbol();

      codeGraph.extractBatch.mockReturnValue([{ path: 'src/a.ts', symbols: [extracted] }]);
      codeGraph.resolveRelationships.mockReturnValue(undefined);
      symbolStore.upsertSymbol.mockResolvedValue(buildSymbolData());

      const result = await service.indexCommit('repo-1', 'abc123', files, 'proj-1');

      expect(codeGraph.extractBatch).toHaveBeenCalledWith(files);
      expect(codeGraph.parseSourceFile).not.toHaveBeenCalled();
      expect(codeGraph.resolveRelationships).toHaveBeenCalled();
      expect(symbolStore.upsertSymbol).toHaveBeenCalledTimes(1);
      expect(result.filesIndexed).toBe(1);
      expect(result.symbolsIndexed).toBe(1);
      expect(result.fileErrors).toHaveLength(0);
    });

    it('records a fileError and skips symbol upsert when parseSourceFile throws', async () => {
      const files: SourceFile[] = [{ path: 'src/bad.ts', content: 'invalid' }];

      codeGraph.extractBatch.mockReturnValue([{ path: 'src/bad.ts', error: 'parse failed' }]);
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

      codeGraph.extractBatch.mockReturnValue([{ path: 'src/x.ts', error: 'string error' }]);
      codeGraph.resolveRelationships.mockReturnValue(undefined);

      const result = await service.indexCommit('repo-1', 'abc123', files, 'proj-1');

      expect(result.fileErrors[0].error).toBe('string error');
    });

    it('assigns unique symbolIds for duplicate names within the same file', async () => {
      const files: SourceFile[] = [{ path: 'src/a.ts', content: '' }];
      const sym1: ExtractedSymbol = buildExtractedSymbol({ name: 'myFn', file: 'src/a.ts' });
      const sym2: ExtractedSymbol = buildExtractedSymbol({ name: 'myFn', file: 'src/a.ts' });
      codeGraph.extractBatch.mockReturnValue([{ path: 'src/a.ts', symbols: [sym1, sym2] }]);
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
      codeGraph.extractBatch.mockReturnValue([{ path: 'src/a.ts', symbols: [extracted] }]);
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
      codeGraph.extractBatch.mockReturnValue([{ path: 'src/a.ts', symbols: [extracted] }]);
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
      const extracted: ExtractedSymbol = buildExtractedSymbol({ name: 'ok', file: 'src/ok.ts' });

      codeGraph.extractBatch.mockReturnValue([
        { path: 'src/ok.ts', symbols: [extracted] },
        { path: 'src/bad.ts', error: 'syntax error' },
      ]);
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
