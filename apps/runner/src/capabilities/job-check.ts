import type { AssignPayload, RunnerCapabilities, RunnerCredential } from '@nathapp/fleet-protocol';
import { parseNaxJson, type NaxCli } from '../nax/nax-cli';
import { checkTrust } from '../nax/trust';
import { parseAuthList, parseRequirements, unavailableCredential, type Requirements } from './nax-json';

/** D104: can this machine run the job? Asked in the clone, after checkout, before nax spawns. */
export interface JobCheck {
  /** null: the machine meets the job's needs; otherwise the job's stateReason. */
  check(assign: Pick<AssignPayload, 'profiles'>, repoDir: string): Promise<string | null>;
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
}

/** D104, S1 spec §2.1: trust, the job's chain resolved in the clone, then the machine's report and a fresh auth listing. */
export class NaxJobCheck implements JobCheck {
  constructor(private readonly deps: NaxJobCheckDeps) {}

  async check(assign: Pick<AssignPayload, 'profiles'>, repoDir: string): Promise<string | null> {
    const { nax, timeoutMs } = this.deps;
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
    const caps = this.deps.capabilities();
    if (!caps) return null;   // the daemon does not start in nax mode without a first report
    const credentials = await this.credentials(repoDir, requirements.providers);
    return typeof credentials === 'string' ? credentials : firstMismatch(requirements, caps, credentials);
  }

  /**
   * A fresh listing: a credential may have expired, or been added, since the last probe. A string is the failure.
   * D99: a provider nax did not list (or listed as a row we cannot carry) is unavailable, the same answer the probe
   * gives — `missing` is permanent to placement, so it must not stand for "nax could not tell us".
   */
  private async credentials(repoDir: string, providers: readonly string[]): Promise<readonly RunnerCredential[] | string> {
    if (providers.length === 0) return [];
    const json = parseNaxJson(await this.deps.nax.run(['auth', 'list', '--json', ...providers], { cwd: repoDir, timeoutMs: this.deps.timeoutMs }));
    const parsed = json.ok ? parseAuthList(json.value) : null;
    if (!parsed) return `capability mismatch: auth list failed (${json.ok ? 'NAX_OUTPUT_UNPARSEABLE' : json.code})`;
    const byId = new Map(parsed.credentials.map((c) => [c.providerId, c] as const));
    return providers.map((id) => byId.get(id) ?? unavailableCredential(id));
  }
}
