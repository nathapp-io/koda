import { readFile } from 'node:fs/promises';

const REVIEW_POSTED_MARKER = 'nax bot review: artifact ';

/** nax emits this stdout line only after it has successfully posted the review. */
export async function reviewPosted(stdoutPath: string): Promise<boolean> {
  let stdout: string;
  try {
    stdout = await readFile(stdoutPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  return stdout.split(/\r?\n/).some((line) => line.startsWith(REVIEW_POSTED_MARKER));
}
