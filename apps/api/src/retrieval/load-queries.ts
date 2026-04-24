import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { EvalQuery } from './evaluation.service';

/**
 * Resolves the eval-queries.json fixture.
 * Uses src/ path directly so it works in both dev (ts-node) and prod (dist).
 * The dist/ path is used as fallback for apps that copy fixtures to dist.
 */
export function loadEvalQueries(): EvalQuery[] {
  const distPath = resolve(__dirname, 'fixtures', 'eval-queries.json');
  const srcPath = resolve(__dirname, '..', '..', 'src', 'retrieval', 'fixtures', 'eval-queries.json');
  const fixturePath = existsSync(srcPath) ? srcPath : distPath;
  const raw = readFileSync(fixturePath, 'utf-8');
  return JSON.parse(raw) as EvalQuery[];
}
