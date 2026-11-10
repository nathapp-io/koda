import type { RunnerCapabilities, RunnerCredential } from '@nathapp/fleet-protocol';
import type { JobRow } from '../journal/types';
import { parseNaxJson, type NaxCli } from '../nax/nax-cli';
import { checkTrust } from '../nax/trust';
import { interactionReason, parseAuthList, parseInteraction, parseRequirements, unavailableCredential, type Requirements } from './nax-json';

/** #406: lets a retrying check stop asking once the job is cancelled. */
export interface JobCheckOptions {
  readonly isCancelled?: () => boolean;
}

/** D104: can this machine run the job? Asked in the clone, after checkout, before nax spawns. */
export interface JobCheck {
  /**
   * null: the machine meets the job's needs; otherwise the job's stateReason. The whole row, not just `assign`: C10
   * resolves a provider through this job epoch's provider-key socket, which is keyed by the job and its lease epoch.
   */
  check(job: JobRow, repoDir: string, options?: JobCheckOptions): Promise<string | null>;
}

/** Static capabilities (D95) and unit specs: no post-checkout check. */
export const NO_JOB_CHECK: JobCheck = { check: async () => null };

/** Placement's order (apps/api/src/fleet/jobs/placement-rules.ts `capabilityMisfit`): protocol, providers, sandbox. */
export function firstMismatch(
  requirements: Requirements,
  caps: Pick<RunnerCapabilities, 'nax' | 'sandbox'>,
  credentials: readonly RunnerCredential[],
): string | null {
  if (!caps.nax.protocols.includes(requirements.transport)) return `capability mismatch: protocol ${requirements.transport}`;
  for (const id of requirements.providers) {
    const credential = credentials.find((c) => c.providerId === id);
    if (!credential) return `capability mismatch: provider ${id} missing`;
    if (!credential.available) return `capability mismatch: provider ${id} unavailable`;
  }
  if (requirements.sandbox && !caps.sandbox.available) return 'capability mismatch: sandbox';
  return null;
}

export interface NaxJobCheckDeps {
  readonly nax: NaxCli;
  /** The last probe report (`CapabilityReporter.latest`). */
  readonly capabilities: () => RunnerCapabilities | null;
  /**
   * D111: this check runs inside the per-repo mutex, so it is bounded well below the probe's `naxCallTimeoutMs`: a
   * wedged nax must not hold every other job on the same repo.
   */
  readonly timeoutMs?: number;
  /**
   * C10 US-009: is `providerId` grantable to this job through its provider-key socket? It is the same lookup the socket
   * answers with (`CredentialBroker.providerKeyGranted`), so a vault-only machine is not refused for a key koda holds.
   * Absent (a runner with no provider cache, a spec): only the machine's own `nax auth` listing counts.
   */
  readonly providerKey?: (job: JobRow, providerId: string) => Promise<boolean>;
}

/** Marks the wait when a caller injects no `timeoutMs`; the daemon always passes `tuning.jobCheckTimeoutMs`. */
const VAULT_LOOKUP_TIMEOUT_MS = 10_000;

/** D104, S1 spec §2.1: trust, the job's chain resolved in the clone, its interaction plugin (#207), then the machine's report and a fresh auth listing. */
export class NaxJobCheck implements JobCheck {
  constructor(private readonly deps: NaxJobCheckDeps) {}

  async check(job: JobRow, repoDir: string): Promise<string | null> {
    const { nax, timeoutMs } = this.deps;
    const { assign } = job;
    const chain = assign.profiles.length > 0 ? ['--profile', assign.profiles.join(',')] : [];
    // Both are local reads nax answers from its own config, so they go together rather than one timeout apart (D111).
    const [trust, json] = await Promise.all([
      checkTrust(nax, repoDir, timeoutMs),
      nax.run(['config', '-d', repoDir, ...chain, '--json'], { cwd: repoDir, timeoutMs }).then(parseNaxJson),
    ]);
    if (!trust.trusted) return trust.reason;
    if (!json.ok) return `capability mismatch: profile resolve failed (${json.code})`;
    const requirements = parseRequirements(json.value);
    if (!requirements) return 'capability mismatch: profile resolve failed (NAX_OUTPUT_UNPARSEABLE)';
    // #207 spec §3.3: nax merged the job's real chain (repo config included), so this is the exact check; placement's
    // per-profile check is an approximation. An absent or unknown result (older nax) passes.
    const interaction = parseInteraction(json.value);
    if (interaction && !interaction.check.ok) return `capability mismatch: ${interactionReason(interaction.check)}`;
    const caps = this.deps.capabilities();
    if (!caps) return null;   // the daemon does not start in nax mode without a first report
    const credentials = await this.credentials(job, repoDir, requirements.providers, caps.providerVault === true);
    return typeof credentials === 'string' ? credentials : firstMismatch(requirements, caps, credentials);
  }

  /**
   * A fresh listing: a credential may have expired, or been added, since the last probe. A string is the failure.
   * D99: a provider nax did not list (or listed as a row we cannot carry) is unavailable, the same answer the probe
   * gives — `missing` is permanent to placement, so it must not stand for "nax could not tell us".
   *
   * C10 US-009: on a vault runner (`providerVault`) `nax auth list` cannot see a koda key — its own process has no
   * `KODA_PROVIDER_CRED_SOCKET`, and the machine holds no file credential — so a provider the machine cannot serve
   * locally is asked of the job's provider-key socket before it is refused. A grant means the spawned nax will resolve
   * the key through the exec helper; no grant keeps today's refusal, which names the provider.
   */
  private async credentials(job: JobRow, repoDir: string, providers: readonly string[], vault: boolean): Promise<readonly RunnerCredential[] | string> {
    if (providers.length === 0) return [];
    const json = parseNaxJson(await this.deps.nax.run(['auth', 'list', '--json', ...providers], { cwd: repoDir, timeoutMs: this.deps.timeoutMs }));
    const parsed = json.ok ? parseAuthList(json.value) : null;
    if (!parsed) return `capability mismatch: auth list failed (${json.ok ? 'NAX_OUTPUT_UNPARSEABLE' : json.code})`;
    const byId = new Map(parsed.credentials.map((c) => [c.providerId, c] as const));
    const resolved = providers.map((id) => byId.get(id) ?? unavailableCredential(id));
    if (!vault) return resolved;
    const unmet = [...new Set(resolved.filter((c) => !c.available).map((c) => c.providerId))];
    if (unmet.length === 0) return resolved;
    // Asked together: the socket answers each provider from the same sync tick, so N lookups cost one round trip.
    const answers = await Promise.all(unmet.map((id) => this.vaultGranted(job, id)));
    const granted = new Set(unmet.filter((_id, index) => answers[index] === true));
    return resolved.map((credential) => (granted.has(credential.providerId) ? { ...credential, available: true } : credential));
  }

  /**
   * C10: one provider looked up through the job's provider-key socket, bounded like the nax calls beside it (D111): the
   * broker waits up to 55 s for a sync answer, and a job must not hold the repo mutex that long. A lookup that throws
   * is no grant — the job would otherwise start without a key, and the refusal names the provider instead.
   */
  private async vaultGranted(job: JobRow, providerId: string): Promise<boolean> {
    const lookup = this.deps.providerKey;
    if (!lookup) return false;
    const timeoutMs = this.deps.timeoutMs ?? VAULT_LOOKUP_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
    try {
      return await Promise.race([lookup(job, providerId).catch(() => false), expired]);
    } finally {
      clearTimeout(timer);
    }
  }
}
