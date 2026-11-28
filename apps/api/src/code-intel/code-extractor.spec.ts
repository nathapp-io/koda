import { InProcessCodeExtractor } from './code-extractor';
import { runExtractionRequest } from './extraction-protocol';
import { CodeGraphService } from './code-graph.service';
import type { ExtractedSymbol, FileExtraction } from './code-graph.service';

const files = [{ path: 'src/a.ts', content: 'export const a = 1;' }];

describe('InProcessCodeExtractor', () => {
  it('AC-1: resolves with the graph batch and calls extractBatch once with the files', async () => {
    const results: FileExtraction[] = [{ path: 'src/a.ts', symbols: [] }];
    const graph = { extractBatch: vi.fn(() => results) };

    const extracted = await new InProcessCodeExtractor(graph).extract(files);

    expect(extracted).toEqual([{ path: 'src/a.ts', symbols: [] }]);
    expect(graph.extractBatch).toHaveBeenCalledTimes(1);
    expect(graph.extractBatch).toHaveBeenCalledWith(files);
  });
});

describe('runExtractionRequest', () => {
  const graph = new CodeGraphService();

  it('AC-2: extracts through the real graph and answers one result per file', () => {
    const response = runExtractionRequest(
      JSON.stringify({ files: [{ path: 'src/a.ts', content: 'export function a() {}' }] }),
      graph,
    );

    const { results } = JSON.parse(response) as { results: FileExtraction[] };
    expect(results).toHaveLength(1);
    const [result] = results as { path: string; symbols: ExtractedSymbol[] }[];
    expect(result.path).toBe('src/a.ts');
    expect(result.symbols.map((symbol) => symbol.name)).toContain('a');
  });

  it('AC-3: throws when the input is not JSON', () => {
    expect(() => runExtractionRequest('not json', graph)).toThrow(Error);
  });

  it('AC-4: throws when files is not an array', () => {
    expect(() => runExtractionRequest(JSON.stringify({ files: 'x' }), graph)).toThrow(Error);
  });

  it('throws when a file entry carries no string content', () => {
    expect(() => runExtractionRequest(JSON.stringify({ files: [{ path: 'src/a.ts' }] }), graph)).toThrow(
      /string path and content/,
    );
  });
});
