import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { EvalQuery } from './evaluation.service';

export function loadEvalQueries(): EvalQuery[] {
  const fixturePath = resolve(__dirname, 'fixtures', 'eval-queries.json');
  const raw = readFileSync(fixturePath, 'utf-8');
  return JSON.parse(raw) as EvalQuery[];
}
