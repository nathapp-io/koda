import type { Logger } from '@nestjs/common';

/**
 * Starts `table.optimize()` without awaiting it. A rejection (or a synchronous
 * throw) is logged instead of surfacing as an unhandled promise rejection.
 */
export function optimizeInBackground(
  table: { optimize: () => Promise<unknown> },
  projectId: string,
  logger: Pick<Logger, 'warn'>,
): void {
  try {
    void Promise.resolve(table.optimize()).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`FTS optimize failed for project ${projectId}: ${message}`);
    });
  } catch (err) {
    logger.warn(`FTS optimize failed for project ${projectId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
