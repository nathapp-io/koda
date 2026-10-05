import { FleetJobState } from '../../common/enums';
import { isRunnerOnline } from '../common/runner-online';
import {
  AttentionItem, AttentionKind, AttentionThresholds, DashboardJobRow, DashboardRunnerRow, PendingSummary, secondsSince, Severity,
} from './dashboard.types';

/** A job-subject attention item. */
export function jobItem(kind: AttentionKind, job: DashboardJobRow, severity: Severity, since: Date, extra: Partial<AttentionItem>): AttentionItem {
  return {
    key: `${kind}:${job.id}`, kind, severity, subjectType: 'job', subjectId: job.id, subjectName: job.feature,
    projectSlug: job.projectSlug, since: since.toISOString(), ...extra,
  };
}

/**
 * Spec §2.1. Only jobs on an existing, online runner: an offline runner's jobs are reported once, on its
 * runner_unhealthy item (jobsHeld). UPLOADING is never evaluated (nax has exited).
 */
export function jobSilentItems(
  jobs: readonly DashboardJobRow[],
  runnersById: ReadonlyMap<string, DashboardRunnerRow>,
  now: Date,
  t: AttentionThresholds,
): AttentionItem[] {
  const errorSec = Math.max(t.jobSilentErrorSec, t.jobSilentSec);
  return jobs.flatMap((job): AttentionItem[] => {
    const runner = job.runnerId ? runnersById.get(job.runnerId) : undefined;
    if (!runner || !isRunnerOnline(runner.lastSeenAt, now, t.runnerOfflineSec)) return [];
    if (job.state === FleetJobState.RUNNING) {
      const from = job.lastHeartbeatAt ?? job.startedAt ?? job.assignedAt;
      if (!from) return [];
      const age = secondsSince(now, from);
      if (age <= t.jobSilentSec) return [];
      return [jobItem('job_silent', job, age > errorSec ? 'error' : 'warning', from, { stage: 'running', silentSec: age, runnerName: runner.name })];
    }
    if (job.state === FleetJobState.ASSIGNED && job.assignedAt) {
      const age = secondsSince(now, job.assignedAt);
      if (age <= t.jobStartSec) return [];
      return [jobItem('job_silent', job, 'warning', job.assignedAt, { stage: 'starting', silentSec: age, runnerName: runner.name })];
    }
    return [];
  });
}

/** Spec §2.2: always an error (a missed ask auto-denies at its timeout). */
export function jobApprovalItems(jobs: readonly DashboardJobRow[], pending: ReadonlyMap<string, PendingSummary>, now: Date): AttentionItem[] {
  return jobs.flatMap((job): AttentionItem[] => {
    const p = pending.get(job.id);
    if (!p || p.count === 0) return [];
    return [jobItem('job_waiting_approval', job, 'error', p.oldestRequestedAt, { pending: p.count, oldestSec: secondsSince(now, p.oldestRequestedAt) })];
  });
}
