import { scanLines } from './scan-lines';

const REVIEW_POSTED_MARKER = 'nax bot review: artifact ';

/** nax emits this stdout line only after it has successfully posted the review. */
export async function reviewPosted(stdoutPath: string): Promise<boolean> {
  let posted = false;
  // US-006: the marker ends the scan, so a long review log costs only the lines up to it.
  const exists = await scanLines(stdoutPath, (line) => {
    if (!line.startsWith(REVIEW_POSTED_MARKER)) return undefined;
    posted = true;
    return 'stop';
  });
  return exists && posted;
}
