/**
 * The lock-aware FTS optimize for one project table (US-006).
 *
 * The strategy never touches the table directly: it runs this task, which takes the table's write mutex
 * (`LanceTableManager.exclusive`) and optimizes inside it. `exclusive` is a non-reentrant promise-chain mutex, so a
 * caller that already holds the table must not await it — the task is queued behind the holder instead.
 */
export type OptimizeTask = () => Promise<void>;

export const FTS_OPTIMIZE_STRATEGY = 'FTS_OPTIMIZE_STRATEGY';

export interface FtsOptimizeStrategy {
  onInsert(projectId: string, optimize: OptimizeTask): Promise<void>;
  onFirstAccess(projectId: string, optimize: OptimizeTask): void;
  onDestroy(): Promise<void>;
  clearProject?(projectId: string): void;
}
