import type { Logger } from '@nestjs/common';
import type { OptimizeTask } from './fts-optimize-strategy.interface';

/**
 * Starts `optimize()` (a lock-aware optimize task) without awaiting it. A rejection (or a synchronous throw) is
 * logged instead of surfacing as an unhandled promise rejection.
 *
 * Used wherever the caller may hold the table's write mutex — awaiting an `exclusive` task there would deadlock —
 * and on first access, where nobody waits for the result.
 */
export function optimizeInBackground(
  optimize: OptimizeTask,
  projectId: string,
  logger: Pick<Logger, 'warn'>,
): void {
  try {
    void Promise.resolve(optimize()).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`FTS optimize failed for project ${projectId}: ${message}`);
    });
  } catch (err) {
    logger.warn(`FTS optimize failed for project ${projectId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
