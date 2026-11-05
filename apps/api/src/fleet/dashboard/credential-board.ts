import type { ProfileNeeds, RunnerCapabilities, RunnerCredential } from '../common/protocol';
import { MisfitReason, profileMisfit } from '../jobs/placement-rules';
import type { ProviderKeySummary } from '../provider-credentials/provider-credential.domain';

/** Fleet S3 §4.4: the admin credential board, derived from `Runner.capabilities` (no storage). */
export type CredentialCellState = 'ok' | 'expiring' | 'expired' | 'unavailable' | 'missing';
export type CredentialCellKind = 'api-key' | 'oauth' | 'exec' | 'ambient' | 'none';
export interface CredentialCell { state: CredentialCellState; kind: CredentialCellKind; expires?: string }
export interface ProfileCell { present: boolean; needs?: ProfileNeeds; misfit?: MisfitReason }
export interface BoardRunner { id: string; name: string; enabled: boolean; online: boolean; capabilities: RunnerCapabilities | null }
export interface CredentialBoardRunner {
  id: string;
  name: string;
  enabled: boolean;
  online: boolean;
  readable: boolean;
  /** C10 US-007: the machine serves koda's provider keys through nax's exec helper (`providerVault` capability). */
  providerVault: boolean;
}
export interface CredentialBoard {
  generatedAt: string;
  warnDays: number;
  /** C10 US-007: the active GLOBAL keys koda holds, as metadata; empty when the vault is off. */
  kodaKeys: ProviderKeySummary[];
  runners: CredentialBoardRunner[];
  providers: Array<{ providerId: string; cells: Record<string, CredentialCell> }>;
  profiles: Array<{ name: string; runners: Record<string, ProfileCell> }>;
}

const DAY_MS = 86_400_000;
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** D473: an unexpired OAuth credential whose `expires` is within `warnDays` (a past, unflagged date counts too). */
export function isExpiring(cred: RunnerCredential, now: Date, warnDays: number): boolean {
  const stored = cred.stored;
  if (stored?.kind !== 'oauth' || stored.expired || stored.expires === undefined) return false;
  const at = Date.parse(stored.expires);
  return Number.isFinite(at) && at - now.getTime() <= warnDays * DAY_MS;
}

function kindOf(cred: RunnerCredential): CredentialCellKind {
  if (cred.stored) return cred.stored.kind;
  if (cred.exec) return 'exec';
  return cred.ambient ? 'ambient' : 'none';
}

function stateOf(cred: RunnerCredential, now: Date, warnDays: number): CredentialCellState {
  if (!cred.available) return 'unavailable';
  if (cred.stored?.expired) return 'expired';
  return isExpiring(cred, now, warnDays) ? 'expiring' : 'ok';
}

export function credentialCell(cred: RunnerCredential | undefined, now: Date, warnDays: number): CredentialCell {
  if (!cred) return { state: 'missing', kind: 'none' };
  const expires = cred.stored?.expires;
  return { state: stateOf(cred, now, warnDays), kind: kindOf(cred), ...(expires !== undefined ? { expires } : {}) };
}

function profileCell(caps: RunnerCapabilities, name: string): ProfileCell {
  if (!Object.prototype.hasOwnProperty.call(caps.profiles, name)) return { present: false };
  const needs = caps.profiles[name];
  const misfit = profileMisfit(needs, caps);
  return { present: true, needs, ...(misfit ? { misfit } : {}) };
}

export function buildCredentialBoard(
  runners: readonly BoardRunner[],
  now: Date,
  warnDays: number,
  kodaKeys: readonly ProviderKeySummary[] = [],
): CredentialBoard {
  const readable = runners.flatMap((r) => (r.capabilities ? [{ id: r.id, caps: r.capabilities }] : []));
  // A koda key names a provider the admin can manage even when no runner reports it (C10 US-007), so
  // the inventory is the union of the runner-reported providers and the koda keys' providers.
  const providerIds = [...new Set([
    ...readable.flatMap(({ caps }) => [
      ...caps.credentials.map((c) => c.providerId),
      ...Object.values(caps.profiles).flatMap((p) => p.providers),
    ]),
    ...kodaKeys.map((key) => key.providerId),
  ])].sort(byCodeUnit);
  const profileNames = [...new Set(readable.flatMap(({ caps }) => Object.keys(caps.profiles)))].sort(byCodeUnit);
  return {
    generatedAt: now.toISOString(),
    warnDays,
    kodaKeys: [...kodaKeys].sort((a, b) => byCodeUnit(a.providerId, b.providerId) || byCodeUnit(a.name, b.name)),
    runners: runners.map((r) => ({
      id: r.id, name: r.name, enabled: r.enabled, online: r.online, readable: r.capabilities !== null,
      providerVault: r.capabilities?.providerVault === true,
    })),
    providers: providerIds.map((providerId) => ({
      providerId,
      cells: Object.fromEntries(readable.map(({ id, caps }) =>
        [id, credentialCell(caps.credentials.find((c) => c.providerId === providerId), now, warnDays)] as const)),
    })),
    profiles: profileNames.map((name) => ({
      name,
      runners: Object.fromEntries(readable.map(({ id, caps }) => [id, profileCell(caps, name)] as const)),
    })),
  };
}
