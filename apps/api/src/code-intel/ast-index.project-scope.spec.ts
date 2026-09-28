import { AstIndexService } from './ast-index.service';
import type { CodeGraphService } from './code-graph.service';
import type { SymbolStore, SymbolData } from './symbol-store';
import type { ITransactionManager } from '@nathapp/nestjs-data';

describe('AstIndexService project-scoped ids (M13)', () => {
  let store: { upsertSymbol: jest.Mock; deleteByFile: jest.Mock };
  let service: AstIndexService;
  const calls: string[] = [];

  beforeEach(() => {
    calls.length = 0;
    store = {
      upsertSymbol: jest.fn(async (s: SymbolData) => { calls.push(`upsert:${s.file}`); return s; }),
      deleteByFile: jest.fn(async (_p: string, _r: string, file: string) => { calls.push(`delete:${file}`); }),
    };
    const graph = {
      parseSourceFile: jest.fn((path: string) => ({ path })),
      extractSymbols: jest.fn(({ path }: { path: string }) => [
        { name: 'alpha', kind: 'function', file: path, startLine: 1, endLine: 2, callers: [], callees: [], symbolId: '' },
      ]),
      resolveRelationships: jest.fn(),
    };
    const tx = { run: <T>(fn: () => Promise<T>) => fn() } as unknown as ITransactionManager;
    service = new AstIndexService(graph as unknown as CodeGraphService, store as unknown as SymbolStore, tx);
  });

  it('puts the project id in the symbol id', async () => {
    await service.indexCommit('acme/widgets', 'c1', [{ path: 'src/a.ts', content: 'x' }], 'proj-1');

    const saved = store.upsertSymbol.mock.calls[0][0] as SymbolData;
    expect(saved.id).toBe('proj-1:acme/widgets:src/a.ts::alpha');
    expect(saved.symbolId).toBe(saved.id);
    expect(saved.projectId).toBe('proj-1');
  });

  it('replaces a re-indexed file: its old symbols are deleted before the new ones are written', async () => {
    await service.indexCommit('acme/widgets', 'c1', [{ path: 'src/a.ts', content: 'x' }], 'proj-1');

    expect(calls).toEqual(['delete:src/a.ts', 'upsert:src/a.ts']);
  });

  it('removeFiles deletes each file\'s symbols in the project', async () => {
    await service.removeFiles('proj-1', 'acme/widgets', ['src/gone.ts', 'src/old-name.ts']);

    expect(store.deleteByFile.mock.calls).toEqual([
      ['proj-1', 'acme/widgets', 'src/gone.ts'],
      ['proj-1', 'acme/widgets', 'src/old-name.ts'],
    ]);
  });
});
