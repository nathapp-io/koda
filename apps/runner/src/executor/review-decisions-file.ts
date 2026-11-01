import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReviewDecision } from '@nathapp/fleet-protocol';

export const REVIEW_DECISIONS_FILE = 'review-decisions.json';

/** Write the caller decisions as compact JSON, restricting access at file creation. */
export async function writeReviewDecisions(jobDir: string, decisions: readonly ReviewDecision[]): Promise<string> {
  const path = join(jobDir, REVIEW_DECISIONS_FILE);
  await writeFile(path, JSON.stringify({ version: 1, decisions }), { mode: 0o600 });
  return path;
}
