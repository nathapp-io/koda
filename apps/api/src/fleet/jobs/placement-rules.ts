import type { RunnerCapabilities } from '../common/protocol';

/** The first placement rule a runner fails (spec §4), reported per runner at dispatch. */
export type MisfitReason =
  | 'disabled' | 'offline' | 'labels' | 'executor' | 'protocol' | 'provider_missing'
  | 'provider_unavailable' | 'sandbox' | 'tools' | 'busy_repo' | 'capacity';

// provider_unavailable is not permanent: a later probe may fix it, so the job queues and a
// pinned dispatch answers 201 (spec §4).
/** A pinned job whose runner fails one of these can never run there: 422 at dispatch (spec §4). */
export const PERMANENT_MISFITS: ReadonlySet<MisfitReason> = new Set<MisfitReason>([
  'disabled', 'executor', 'protocol', 'provider_missing', 'sandbox', 'tools',
]);

export interface PlacementJob {
  repoId: string;
  provider: 'github' | 'gitlab';
  profiles: readonly string[];
  selectorLabels: readonly string[];
  pinnedRunnerId: string | null;
}

export interface PlacementRunner {
  id: string;
  name: string;
  enabled: boolean;
  lastSeenAt: Date;
  labels: readonly string[];
  capacity: number;
  capabilities: RunnerCapabilities;
}

/** The runner's active jobs (ASSIGNED, RUNNING, UPLOADING). */
export interface RunnerLoad {
  active: number;
  repoIds: ReadonlySet<string>;
}

export const EMPTY_LOAD: RunnerLoad = Object.freeze({ active: 0, repoIds: new Set<string>() });

const own = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);

function capabilityMisfit(job: PlacementJob, caps: RunnerCapabilities): MisfitReason | null {
  for (const name of job.profiles) {
    // A name the runner does not report is repo-provided and unknowable before clone (spec §2.1).
    if (!own(caps.profiles, name)) continue;
    const needs = caps.profiles[name];
    if (!caps.nax.protocols.includes(needs.protocol)) return 'protocol';
    for (const provider of needs.providers) {
      const credential = caps.credentials.find((c) => c.providerId === provider);
      if (!credential) return 'provider_missing';
      // nax's own verdict (slice 3 design §1.1): available deliberately ignores access-token expiry.
      if (!credential.available) return 'provider_unavailable';
    }
    if (needs.sandbox && !caps.sandbox.available) return 'sandbox';
  }
  const forgeTool = job.provider === 'github' ? caps.tools.gh : caps.tools.glab;
  if (!caps.tools.git || !forgeTool) return 'tools';
  return null;
}

/** Spec §4 steps 1-3, in order. Pinned jobs ignore selector labels (the pin is the candidate set). */
export function firstMisfit(job: PlacementJob, runner: PlacementRunner, load: RunnerLoad, now: Date, offlineSec: number): MisfitReason | null {
  if (!runner.enabled) return 'disabled';
  if (now.getTime() - runner.lastSeenAt.getTime() > offlineSec * 1000) return 'offline';
  if (job.pinnedRunnerId === null && !job.selectorLabels.every((label) => runner.labels.includes(label))) return 'labels';
  if (!runner.capabilities.executors.includes('host')) return 'executor';
  const capability = capabilityMisfit(job, runner.capabilities);
  if (capability) return capability;
  if (load.repoIds.has(job.repoId)) return 'busy_repo';
  if (load.active >= runner.capacity) return 'capacity';
  return null;
}

/** Spec §4 step 4: fewest active jobs, then oldest lastSeenAt; id breaks ties deterministically. */
export function orderCandidates<T extends { runner: PlacementRunner; load: RunnerLoad }>(fits: readonly T[]): T[] {
  return [...fits].sort(
    (a, b) =>
      a.load.active - b.load.active ||
      a.runner.lastSeenAt.getTime() - b.runner.lastSeenAt.getTime() ||
      a.runner.id.localeCompare(b.runner.id),
  );
}
