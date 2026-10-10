import { Prisma } from '../../generated/prisma/client';
import { FleetJobState } from '../../common/enums';
import type { BudgetPolicyRecord } from '../budgets/domain/budget.domain';

/** One refusal per applicable send check; the first that applies answers (US-005 order). */
export type ThreadSendRefusal = 'disabled' | 'archived' | 'costCap' | 'budgetPaused' | 'runnerOffline' | 'runnerOutdated' | 'closing' | 'turnRunning';

/** A runner hosts a thread session only from this protocol version (S5a). */
export const THREAD_MIN_PROTOCOL_VERSION = 4;

/** The facts a send is judged on, read under the thread and job locks. */
export interface ThreadSendState {
  threadsEnabled?: boolean;
  status: string;
  costUsd: Prisma.Decimal | string | number;
  maxCostUsd: Prisma.Decimal | string | number;
  /** The policy that pauses a job scope of this thread (S1b §2.3), or null. */
  pausedPolicy?: Pick<BudgetPolicyRecord, 'id'> | null;
  /** The pinned runner, or null while the thread has none. */
  runner?: { online: boolean; protocolVersion: number } | null;
  /** The thread's current THREAD job, or null. `closeRequested`: a THREAD_CLOSE is queued at its epoch. */
  job?: { state: string; closeRequested: boolean } | null;
  /** A message of this thread is pending or streaming. */
  turnInFlight?: boolean;
}

/** The first send refusal that applies, or null when the send may proceed. Pure: writes nothing. */
export function sendRefusal(state: ThreadSendState): ThreadSendRefusal | null {
  if (state.threadsEnabled === false) return 'disabled';
  if (state.status === 'ARCHIVED') return 'archived';
  if (new Prisma.Decimal(state.costUsd).gte(state.maxCostUsd)) return 'costCap';
  if (state.pausedPolicy) return 'budgetPaused';
  if (state.runner && !state.runner.online) return 'runnerOffline';
  if (state.runner && state.runner.protocolVersion < THREAD_MIN_PROTOCOL_VERSION) return 'runnerOutdated';
  if (state.job?.state === FleetJobState.UPLOADING) return 'closing';
  if (state.job?.state === FleetJobState.RUNNING && state.job.closeRequested) return 'closing';
  if (state.turnInFlight || state.job?.state === FleetJobState.QUEUED || state.job?.state === FleetJobState.ASSIGNED) return 'turnRunning';
  return null;
}
