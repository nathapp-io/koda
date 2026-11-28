import { AstIndexService } from './ast-index.service';
import { CodeGraphService, FileExtraction } from './code-graph.service';
import { CodeExtractionError, CodeExtractor } from './code-extractor';
import type { SymbolStore } from './symbol-store';
import type { ITransactionManager } from '@nathapp/nestjs-data';

const files = [{ path: 'src/a.ts', content: 'A' }, { path: 'src/b.ts', content: 'B' }];

function harness(extractor: CodeExtractor) {
  const graph = {
    extractBatch: vi.fn((): FileExtraction[] => []),
    resolveRelationships: vi.fn(),
  };
  const store = { deleteByFile: vi.fn(async () => undefined), upsertSymbol: vi.fn(async () => undefined) };
  const tx = { run: vi.fn((callback: () => Promise<unknown>) => callback()) } as unknown as ITransactionManager;
  const service = new AstIndexService(graph as unknown as CodeGraphService, store as unknown as SymbolStore, tx, extractor);
  return { service, graph, store, tx };
}

describe('AstIndexService extraction boundary', () => {
  it('AC-7: awaits the injected extractor once with files in order, never extracting directly', async () => {
    const extractor = { extract: vi.fn().mockResolvedValue(files.map(({ path }) => ({ path, symbols: [] }))) } as unknown as CodeExtractor;
    const { service, graph } = harness(extractor);

    await service.indexCommit('acme/widgets', 'c1', files, 'proj-1');

    expect(extractor.extract).toHaveBeenCalledTimes(1);
    expect(extractor.extract).toHaveBeenCalledWith(files);
    expect(graph.extractBatch).not.toHaveBeenCalled();
  });

  it('AC-9: propagates the identical extraction error', async () => {
    const error = new CodeExtractionError('timeout');
    const extractor = { extract: vi.fn().mockRejectedValue(error) } as unknown as CodeExtractor;
    const { service } = harness(extractor);

    await expect(service.indexCommit('repo', 'c1', files, 'proj-1')).rejects.toBe(error);
  });

  it('AC-10: does not delete or upsert symbols when extraction fails', async () => {
    const extractor = { extract: vi.fn().mockRejectedValue(new CodeExtractionError('exit')) } as unknown as CodeExtractor;
    const { service, store } = harness(extractor);

    await expect(service.indexCommit('repo', 'c1', files, 'proj-1')).rejects.toBeInstanceOf(CodeExtractionError);
    expect(store.deleteByFile).not.toHaveBeenCalled();
    expect(store.upsertSymbol).not.toHaveBeenCalled();
  });

  it('AC-11: does not open a transaction when extraction fails', async () => {
    const extractor = { extract: vi.fn().mockRejectedValue(new CodeExtractionError('exit')) } as unknown as CodeExtractor;
    const { service, tx } = harness(extractor);

    await expect(service.indexCommit('repo', 'c1', files, 'proj-1')).rejects.toBeInstanceOf(CodeExtractionError);
    expect(tx.run).not.toHaveBeenCalled();
  });
});
