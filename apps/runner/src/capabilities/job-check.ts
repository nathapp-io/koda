import type { AssignPayload, RunnerCapabilities, RunnerCredential } from '@nathapp/fleet-protocol';
import { parseNaxJson, type NaxCli } from '../nax/nax-cli';
import { checkTrust } from '../nax/trust';
import { parseAuthList, parseRequirements, type Requirements } from './nax-json';

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
}

/** D104, S1 spec §2.1: trust, the job's chain resolved in the clone, then the machine's report and a fresh auth listing. */
export class NaxJobCheck implements JobCheck {
  constructor(private readonly deps: NaxJobCheckDeps) {}

  async check(assign: Pick<AssignPayload, 'profiles'>, repoDir: string): Promise<string | null> {
    const trust = await checkTrust(this.deps.nax, repoDir);
    if (!trust.trusted) return trust.reason;
    const chain = assign.profiles.length > 0 ? ['--profile', assign.profiles.join(',')] : [];
    const json = parseNaxJson(await this.deps.nax.run(['config', '-d', repoDir, ...chain, '--json'], { cwd: repoDir }));
    if (!json.ok) return `capability mismatch: profile resolve failed (${json.code})`;
    const requirements = parseRequirements(json.value);
    if (!requirements) return 'capability mismatch: profile resolve failed (NAX_OUTPUT_UNPARSEABLE)';
    const caps = this.deps.capabilities();
    if (!caps) return null;   // the daemon does not start in nax mode without a first report
    const credentials = await this.credentials(repoDir, requirements.providers);
    return typeof credentials === 'string' ? credentials : firstMismatch(requirements, caps, credentials);
  }

  /** A fresh listing: a credential may have expired, or been added, since the last probe. A string is the failure. */
  private async credentials(repoDir: string, providers: readonly string[]): Promise<readonly RunnerCredential[] | string> {
    if (providers.length === 0) return [];
    const json = parseNaxJson(await this.deps.nax.run(['auth', 'list', '--json', ...providers], { cwd: repoDir }));
    const parsed = json.ok ? parseAuthList(json.value) : null;
    return parsed ? parsed.credentials : `capability mismatch: auth list failed (${json.ok ? 'NAX_OUTPUT_UNPARSEABLE' : json.code})`;
  }
}
