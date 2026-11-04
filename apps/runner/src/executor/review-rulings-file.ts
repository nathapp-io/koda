import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CallerRuling } from '@nathapp/fleet-protocol';

export const REVIEW_RULINGS_FILE = 'review-rulings.json';

/** nax's private caller-rulings contract; preserve the snapshot and its four caller fields. */
export async function writeReviewRulings(jobDir: string, rulings: { headSha: string; rulings: readonly CallerRuling[] }): Promise<string> {
  const path = join(jobDir, REVIEW_RULINGS_FILE);
  await writeFile(path, JSON.stringify({ version: 1, headSha: rulings.headSha, rulings: rulings.rulings }), { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}
