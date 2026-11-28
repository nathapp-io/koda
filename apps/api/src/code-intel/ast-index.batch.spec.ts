import { AstIndexService } from './ast-index.service';
import { CodeGraphService, ExtractedSymbol, FileExtraction } from './code-graph.service';
import type { SymbolData, SymbolStore } from './symbol-store';
import type { ITransactionManager } from '@nathapp/nestjs-data';

const files = [
  { path: 'src/a.ts', content: 'A' },
  { path: 'src/b.ts', content: 'B' },
];

const alpha: ExtractedSymbol = {
  name: 'alpha', kind: 'function', file: 'src/a.ts', startLine: 1, endLine: 1, callers: [], callees: [],
};

describe('AstIndexService batch indexing', () => {
  it('AC-1/AC-2: extracts all files once in order and skips per-file parsing', async () => {
    const graph = {
      extractBatch: vi.fn((): FileExtraction[] => files.map(({ path }) => ({ path, symbols: [] }))),
      parseSourceFile: vi.fn(),
      resolveRelationships: vi.fn(),
    };
    const store = { deleteByFile: vi.fn(async () => undefined), upsertSymbol: vi.fn(async () => undefined) };
    const tx = { run: <T>(callback: () => Promise<T>) => callback() } as ITransactionManager;
    const service = new AstIndexService(graph as unknown as CodeGraphService, store as unknown as SymbolStore, tx, { extract: async (batch) => graph.extractBatch(batch) });

    const result = await service.indexCommit('acme/widgets', 'c1', files, 'proj-1');

    expect(graph.extractBatch).toHaveBeenCalledTimes(1);
    expect(graph.extractBatch).toHaveBeenCalledWith(files);
    expect(graph.parseSourceFile).not.toHaveBeenCalled();
    expect(result.filesIndexed).toBe(2);
  });

  it('AC-3/AC-4: reports failed paths, replaces each file, and persists the successful symbol id', async () => {
    const results: FileExtraction[] = [
      { path: 'src/a.ts', symbols: [alpha] },
      { path: 'src/b.ts', error: 'Parse error: x' },
    ];
    const graph = {
      extractBatch: vi.fn(() => results), parseSourceFile: vi.fn(), resolveRelationships: vi.fn(),
    };
    const store = {
      deleteByFile: vi.fn(async () => undefined),
      upsertSymbol: vi.fn(async (_symbol: SymbolData) => undefined),
    };
    const tx = { run: <T>(callback: () => Promise<T>) => callback() } as ITransactionManager;
    const service = new AstIndexService(graph as unknown as CodeGraphService, store as unknown as SymbolStore, tx, { extract: async (batch) => graph.extractBatch(batch) });

    const result = await service.indexCommit('acme/widgets', 'c1', files, 'proj-1');

    expect(result.filesIndexed).toBe(1);
    expect(result.fileErrors).toEqual([{ path: 'src/b.ts', error: 'Parse error: x' }]);
    expect(store.deleteByFile.mock.calls).toEqual([
      ['proj-1', 'acme/widgets', 'src/a.ts'],
      ['proj-1', 'acme/widgets', 'src/b.ts'],
    ]);
    expect(store.upsertSymbol).toHaveBeenCalledTimes(1);
    expect(store.upsertSymbol.mock.calls[0][0].id).toBe('proj-1:acme/widgets:src/a.ts::alpha');
  });

  it('AC-5: warns once with the path of each failed extraction', async () => {
    const graph = {
      extractBatch: vi.fn((): FileExtraction[] => [
        { path: 'src/a.ts', symbols: [alpha] },
        { path: 'src/b.ts', error: 'Parse error: x' },
      ]),
      parseSourceFile: vi.fn(), resolveRelationships: vi.fn(),
    };
    const store = { deleteByFile: vi.fn(async () => undefined), upsertSymbol: vi.fn(async () => undefined) };
    const tx = { run: <T>(callback: () => Promise<T>) => callback() } as ITransactionManager;
    const service = new AstIndexService(graph as unknown as CodeGraphService, store as unknown as SymbolStore, tx, { extract: async (batch) => graph.extractBatch(batch) });
    const warn = vi.spyOn((service as unknown as { logger: { warn: (message: string) => void } }).logger, 'warn');
    warn.mockClear();

    await service.indexCommit('acme/widgets', 'c1', files, 'proj-1');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('src/b.ts');
  });

  it('AC-6: indexes decorated classes and methods through the real CodeGraphService', async () => {
    const graph = new CodeGraphService();
    const extractBatch = vi.spyOn(graph, 'extractBatch');
    const saved: SymbolData[] = [];
    const store = {
      deleteByFile: vi.fn(async () => undefined),
      upsertSymbol: vi.fn(async (symbol: SymbolData) => { saved.push(symbol); }),
    };
    const tx = { run: <T>(callback: () => Promise<T>) => callback() } as ITransactionManager;
    const service = new AstIndexService(graph, store as unknown as SymbolStore, tx, { extract: async (batch) => graph.extractBatch(batch) });
    const content = "declare function Inject(_t: string): ParameterDecorator;\nclass Svc { constructor(@Inject('X') private readonly x: string) {} run(): number { return 1; } }";

    const result = await service.indexCommit('acme/widgets', 'c1', [{ path: 'src/svc.ts', content }], 'proj-1');

    expect(result.fileErrors).toEqual([]);
    expect(extractBatch).toHaveBeenCalledWith([{ path: 'src/svc.ts', content }]);
    expect(saved.map(({ name }) => name)).toEqual(expect.arrayContaining(['Svc', 'Svc.run']));
  });
});
