import { FleetJobState } from '../../common/enums';
import type { EffectJob } from './prisma-fleet-tickets.repository';

/** Spec §3.2 (D453): the terminal states that comment on linked tickets. */
export const FAILURE_STATES: ReadonlySet<string> = new Set([FleetJobState.FAILED, FleetJobState.ESCALATED, FleetJobState.CRASHED]);
export const MAX_REASON_CHARS = 500;

function reasonOf(job: EffectJob): string {
  const raw = (job.state === FleetJobState.ESCALATED ? job.escalationReason?.trim() || job.stateReason : job.stateReason)?.trim();
  if (!raw) return 'no reason recorded';
  return raw.length > MAX_REASON_CHARS ? `${raw.slice(0, MAX_REASON_CHARS - 3)}...` : raw;
}

export function failureCommentBody(job: EffectJob): string {
  return `Fleet ${job.command} job ${job.id} ended ${job.state}: ${reasonOf(job)}\n/${job.projectSlug}/fleet/jobs/${job.id}`;
}
