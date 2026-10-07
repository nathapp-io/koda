import type { InteractionCheck, RunnerCapabilities } from '../common/protocol';
import { isRunnerOnline } from '../common/runner-online';
import { isExpiring } from './credential-board';
import { AttentionItem, AttentionThresholds, DashboardRunnerRow, RunnerCondition, Severity } from './dashboard.types';
import { compareCore, CoreVersion, formatCore, parseCoreVersion } from './nax-version';

/** D414: the newest core version among enabled, online runners with readable, parsable versions. */
export function latestOnlineCore(runners: readonly DashboardRunnerRow[], now: Date, offlineSec: number): CoreVersion | null {
  return runners
    .filter((r) => r.enabled && isRunnerOnline(r.lastSeenAt, now, offlineSec))
    .map((r) => parseCoreVersion(r.capabilities?.nax.version))
    .filter((v): v is CoreVersion => v !== null)
    .reduce<CoreVersion | null>((best, v) => (best === null || compareCore(v, best) > 0 ? v : best), null);
}

/**
 * Spec §2.4, D405: providers named by the runner's own profiles that have no credential (missing) or
 * an unavailable one; then api-key credentials that expired; then (S3 §4.4, D473) OAuth credentials expiring within
 * the window. OAuth expiry itself is still ignored (nax refreshes; placement follows `available`).
 */
function credentialConditions(caps: RunnerCapabilities, now: Date, warnDays: number): RunnerCondition[] {
  const needed = [...new Set(Object.values(caps.profiles).flatMap((p) => p.providers))].sort();
  const fromProfiles = needed.flatMap((providerId): RunnerCondition[] => {
    const credential = caps.credentials.find((c) => c.providerId === providerId);
    if (!credential) return [{ type: 'credential', providerId, why: 'missing' }];
    return credential.available ? [] : [{ type: 'credential', providerId, why: 'unavailable' }];
  });
  const reported = new Set(fromProfiles.map((c) => c.providerId));
  const expired = caps.credentials
    .filter((c) => c.stored?.kind === 'api-key' && c.stored.expired && !reported.has(c.providerId))
    .map((c): RunnerCondition => ({ type: 'credential', providerId: c.providerId, why: 'expired' }));
  const seen = new Set([...reported, ...expired.map((c) => c.providerId)]);
  const expiring = caps.credentials
    .filter((c) => c.available && !seen.has(c.providerId) && isExpiring(c, now, warnDays))
    .map((c): RunnerCondition => ({ type: 'credential', providerId: c.providerId, why: 'expiring' }));
  return [...fromProfiles, ...expired, ...expiring];
}

/** #207 spec §4.3: base config first, then profiles by code unit; a runner with many broken profiles almost always has one broken base. */
export const MAX_INTERACTION_CONDITIONS = 5;

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const interactionCondition = (check: InteractionCheck, profile?: string): RunnerCondition => ({
  type: 'interaction',
  ...(check.plugin !== null ? { plugin: check.plugin } : {}),
  ...(check.code !== undefined ? { code: check.code } : {}),
  ...(profile !== undefined ? { profile } : {}),
});

function interactionConditions(caps: RunnerCapabilities): RunnerCondition[] {
  const base = caps.interaction?.ok === false ? [interactionCondition(caps.interaction)] : [];
  const profiles = Object.entries(caps.profiles)
    .flatMap(([name, needs]) => (needs.interaction?.ok === false ? [{ name, check: needs.interaction }] : []))
    .sort((a, b) => byCodeUnit(a.name, b.name))
    .map(({ name, check }) => interactionCondition(check, name));
  return [...base, ...profiles].slice(0, MAX_INTERACTION_CONDITIONS);
}

function staleCondition(caps: RunnerCapabilities, latest: CoreVersion | null): RunnerCondition | null {
  const core = parseCoreVersion(caps.nax.version);
  if (!core || !latest || compareCore(core, latest) >= 0) return null;
  return { type: 'stale_nax', version: caps.nax.version, latest: formatCore(latest) };
}

/** Spec §2.4: one item per enabled runner with at least one condition (plus a disabled one that went offline holding jobs); full (admin) detail. */
export function runnerUnhealthyItems(
  runners: readonly DashboardRunnerRow[],
  heldByRunner: ReadonlyMap<string, number>,
  fixableBlocked: ReadonlySet<string>,
  now: Date,
  t: AttentionThresholds,
): AttentionItem[] {
  const latest = latestOnlineCore(runners, now, t.runnerOfflineSec);
  return runners.flatMap((r): AttentionItem[] => {
    const online = isRunnerOnline(r.lastSeenAt, now, t.runnerOfflineSec);
    const jobsHeld = heldByRunner.get(r.id) ?? 0;
    // A disabled runner is a deliberate admin choice, except when it went offline still holding jobs: nothing else
    // reports those jobs (job_silent skips offline runners), so it keeps its offline condition only.
    if (!r.enabled && (online || jobsHeld === 0)) return [];
    const offline: RunnerCondition[] = online ? [] : [{ type: 'offline', jobsHeld }];
    const caps = r.enabled ? r.capabilities : null;
    const credentials = caps ? credentialConditions(caps, now, t.credentialExpiryWarnDays) : [];
    const interaction = caps ? interactionConditions(caps) : [];
    const stale = caps ? staleCondition(caps, latest) : null;
    const conditions = [...offline, ...credentials, ...interaction, ...(stale ? [stale] : [])];
    if (conditions.length === 0) return [];
    // A runner-fixable condition is an error once it keeps a queued job unplaced (spec §2.4; #207 adds interaction).
    // `expiring` blocks no placement, so it never makes the item an error (S3 §4.4).
    const fixable = credentials.filter((c) => c.why !== 'expiring').length + interaction.length > 0;
    const error = (!online && jobsHeld > 0) || (fixable && fixableBlocked.has(r.id));
    const severity: Severity = error ? 'error' : 'warning';
    return [{
      key: `runner_unhealthy:${r.id}`, kind: 'runner_unhealthy', severity, subjectType: 'runner', subjectId: r.id, subjectName: r.name,
      projectSlug: null, since: online ? null : r.lastSeenAt.toISOString(), conditions,
    }];
  });
}
