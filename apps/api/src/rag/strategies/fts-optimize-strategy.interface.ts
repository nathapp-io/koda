// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LanceTable = any;

export const FTS_OPTIMIZE_STRATEGY = 'FTS_OPTIMIZE_STRATEGY';

export interface FtsOptimizeStrategy {
  onInsert(projectId: string, table: LanceTable): Promise<void>;
  onFirstAccess(projectId: string, table: LanceTable): void;
  onDestroy(): Promise<void>;
}
