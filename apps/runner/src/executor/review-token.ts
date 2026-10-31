import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * US-006, the one file exception to D88 (`A git token never goes to ... a file`): `nax bot review` accepts an injected
 * forge identity (nax feature `bot-forge-identity`, "K0") and rejects a login without a token file, and a GitHub App
 * token cannot answer "who am I". nax reads the file and deletes it at startup; the runner owns what is left behind.
 */
export const REVIEW_TOKEN_FILE = 'forge-token';

/**
 * The job's current token in `<jobDir>/forge-token`, created mode 0600 by the write itself (never a permissive write
 * followed by a chmod). One call, so the token is never observable in a wider file.
 */
export async function writeReviewToken(jobDir: string, token: string): Promise<string> {
  const path = join(jobDir, REVIEW_TOKEN_FILE);
  await writeFile(path, token, { mode: 0o600 });
  return path;
}

/** Removes a leftover: after a failed start, at job cleanup, and in the attempt wipe before a retry reuses the dir. */
export async function removeReviewToken(jobDir: string): Promise<void> {
  await rm(join(jobDir, REVIEW_TOKEN_FILE), { force: true });
}
