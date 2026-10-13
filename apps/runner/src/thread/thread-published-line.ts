import { THREAD_STREAM_LIMITS } from '@nathapp/fleet-protocol';

/**
 * Whether a `published` result line for these paths is guaranteed to fit the thread stream's line limit,
 * reserving worst-case timestamp and SHA space. A publisher calls this BEFORE it commits or moves the
 * feature ref: the event writer's own size guard runs after the commit, and can only report
 * `publish_failed` for a commit that already exists.
 */
export function publishedLineFits(paths: readonly string[], ignored: readonly string[]): boolean {
  const worstCase = {
    type: 'published', at: '9999-12-31T23:59:59.999Z', sha: 'f'.repeat(64), paths, ignored, specPresent: false,
  };
  return Buffer.byteLength(`${JSON.stringify(worstCase)}\n`, 'utf8') <= THREAD_STREAM_LIMITS.lineMaxBytes;
}
