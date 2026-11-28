import { ChildProcessCodeExtractor } from './child-process-code-extractor';
import { CodeExtractor, InProcessCodeExtractor } from './code-extractor';
import type { CodeGraphService } from './code-graph.service';

export type CodeExtractionMode = 'child' | 'inprocess';

export function readCodeIntelConfig(env: Record<string, string | undefined>): { extractionMode: CodeExtractionMode } {
  const mode = env['CODE_INTEL_EXTRACTION_MODE'];
  if (mode === undefined || mode === '') return { extractionMode: 'child' };
  if (mode === 'child' || mode === 'inprocess') return { extractionMode: mode };
  throw new Error(`Invalid CODE_INTEL_EXTRACTION_MODE: ${mode}`);
}

export function createCodeExtractor(
  config: { extractionMode: CodeExtractionMode },
  graph: CodeGraphService,
): CodeExtractor {
  return config.extractionMode === 'inprocess'
    ? new InProcessCodeExtractor(graph)
    : new ChildProcessCodeExtractor();
}
