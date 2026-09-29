import { FleetJobState } from '../../common/enums';

export type TransitionActor = 'server' | 'runner';

const S = FleetJobState;

/** States covered by the partial unique index on (repoId, feature) (spec §2, §6.4). */
export const ACTIVE_STATES: readonly FleetJobState[] = [S.QUEUED, S.ASSIGNED, S.RUNNING, S.UPLOADING];
/** States in which a runner holds the job (fence, broker, sweep). */
export const RUNNER_HELD_STATES: readonly FleetJobState[] = [S.ASSIGNED, S.RUNNING, S.UPLOADING];
export const TERMINAL_STATES: readonly FleetJobState[] = [S.COMPLETED, S.FAILED, S.ESCALATED, S.CRASHED, S.CANCELLED];

const table = (rows: Array<[FleetJobState, FleetJobState[]]>): ReadonlyMap<string, ReadonlySet<string>> =>
  new Map(rows.map(([from, to]) => [from, new Set(to)]));

/** Spec §5.4 server-owned rows, plus UPLOADING -> CRASHED (plan D11). */
const SERVER = table([
  [S.QUEUED, [S.ASSIGNED, S.CANCELLED]],
  [S.ASSIGNED, [S.CANCELLED, S.CRASHED]],
  [S.RUNNING, [S.CRASHED]],
  [S.UPLOADING, [S.CRASHED]],
  [S.CRASHED, [S.QUEUED]],
  [S.FAILED, [S.QUEUED]],
  [S.CANCELLED, [S.QUEUED]],
]);

/** Spec §5.4 runner-reported rows. */
const RUNNER = table([
  [S.ASSIGNED, [S.RUNNING, S.FAILED, S.CANCELLED]],
  [S.RUNNING, [S.UPLOADING, S.CANCELLED]],
  [S.UPLOADING, [S.COMPLETED, S.FAILED, S.ESCALATED, S.CANCELLED]],
]);

export function canTransition(from: string, to: string, by: TransitionActor): boolean {
  return (by === 'server' ? SERVER : RUNNER).get(from)?.has(to) ?? false;
}

export function isTerminal(state: string): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}
