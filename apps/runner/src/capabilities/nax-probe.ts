import type { Dirent } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InteractionCheck, NaxProtocol, ProfileNeeds, RunnerCapabilities, RunnerCredential } from '@nathapp/fleet-protocol';
import { withoutCredentialVars } from '../credentials/credential-env';
import { sanitizeDiagnostic } from '../diagnostics';
import { PROFILE_NAME, RESERVED_PREFIX } from '../executor/nax-process';
import { parseNaxJson, readNaxVersion, relaySupported, type NaxCli } from '../nax/nax-cli';
import type { Now } from '../time';
import type { CapabilityProbe, ProbeResult } from './capability-probe';
import { mapLimit } from './map-limit';
import {
  MAX_PROVIDERS_PER_PROFILE, parseAuthList, parseInteraction, parseRequirements, parseSandboxProbe, toProfileNeeds, unavailableCredential,
  type Interaction,
} from './nax-json';

/** The server validator's limits (apps/api/src/fleet/common/capabilities.ts). */
export const MAX_PROFILES = 64;
export const MAX_CREDENTIALS = 64;
/** D113: the same validator rejects a report over this many bytes, whole, which disables placement for this runner. */
export const MAX_REPORT_BYTES = 65_536;
const PROFILE_CONCURRENCY = 4;
const TOOL_TIMEOUT_MS = 10_000;

/** #207 spec §3.2: one wording for the base config and for a profile. */
function interactionWarning(subject: string, interaction: Interaction): string {
  const { plugin, code } = interaction.check;
  const detail = interaction.message === null ? '' : ` (${sanitizeDiagnostic(interaction.message)})`;
  return `interaction ${plugin ?? 'unknown'} failed for ${subject}: ${code ?? 'INTERACTION_INIT_FAILED'}${detail}`;
}

export interface EmptyDir {
  readonly dir: string;
  remove(): Promise<void>;
}

export interface NaxProbeDeps {
  readonly nax: NaxCli;
  readonly naxHome: string;
  readonly now: Now;
  /** D101: true when `<command> --version` exits 0. */
  readonly toolWorks: (command: string) => Promise<boolean>;
  /** D98: machine profiles are resolved from a directory with no project config. */
  readonly makeEmptyDir?: () => Promise<EmptyDir>;
}

export async function makeEmptyDir(): Promise<EmptyDir> {
  const dir = await mkdtemp(join(tmpdir(), 'koda-runner-probe-'));
  return { dir, remove: () => rm(dir, { recursive: true, force: true }) };
}

/** D101: `Bun.which` first, then `<command> --version` with a 10 s timeout and no forge token in its environment. */
export async function toolWorks(command: string): Promise<boolean> {
  const path = Bun.which(command);
  if (!path) return false;
  try {
    const proc = Bun.spawn([path, '--version'], {
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', timeout: TOOL_TIMEOUT_MS, killSignal: 'SIGKILL', env: { ...withoutCredentialVars(process.env) },
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

/** D98: `<naxHome>/profiles/*.json` names without koda's job overlays, sorted by code unit. */
export interface ProfileListing {
  readonly names: readonly string[];
  /** D112: the directory exists but could not be read, so this machine's profile list is unknown, not empty. */
  readonly warning: string | null;
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export async function listProfileNames(naxHome: string): Promise<ProfileListing> {
  const dir = join(naxHome, 'profiles');
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ENOENT/ENOTDIR: nax has no profiles here, which is an answer. Anything else is a failure we must not answer "none" for.
    if (code === 'ENOENT' || code === 'ENOTDIR') return { names: [], warning: null };
    return { names: [], warning: `cannot read ${dir} (${code ?? 'unknown error'}): this machine reports no profiles` };
  }
  const names = entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.json'))
    .map((entry) => entry.name.slice(0, -'.json'.length))
    .filter((name) => !name.startsWith(RESERVED_PREFIX))
    .sort(byCodeUnit);
  return { names, warning: null };
}

type Resolved =
  | { readonly name: string; readonly needs: ProfileNeeds; readonly warning?: string }
  | { readonly name: string; readonly error: string };

interface ProfileScan {
  readonly profiles: Record<string, ProfileNeeds>;
  readonly providers: readonly string[];
  readonly warnings: readonly string[];
}

const byProviderId = (a: RunnerCredential, b: RunnerCredential): number => (a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0);

const reportBytes = (caps: RunnerCapabilities): number => Buffer.byteLength(JSON.stringify(caps), 'utf8');
const neededProviders = (profiles: RunnerCapabilities['profiles']): ReadonlySet<string> => new Set(Object.values(profiles).flatMap((needs) => needs.providers));

/**
 * D113: the per-item limits are not enough — the server also rejects a report over `MAX_REPORT_BYTES` whole, which
 * disables placement for this runner, so the probe sheds entries instead of sending one. Least load-bearing first:
 * credentials no kept profile needs, then profiles from the end (placement already reads a name it does not report as
 * unknowable, so the kept set stays a stable prefix), then whatever is still over.
 */
function boundReport(caps: RunnerCapabilities): { readonly capabilities: RunnerCapabilities; readonly warnings: readonly string[] } {
  if (reportBytes(caps) <= MAX_REPORT_BYTES) return { capabilities: caps, warnings: [] };
  const warnings: string[] = [];
  const over = `the report would exceed the server's ${MAX_REPORT_BYTES}-byte cap`;
  let bounded = caps;
  const needed = neededProviders(bounded.profiles);
  const extras = bounded.credentials.filter((c) => !needed.has(c.providerId)).length;
  if (extras > 0) {
    bounded = { ...bounded, credentials: bounded.credentials.filter((c) => needed.has(c.providerId)) };
    warnings.push(`dropped ${extras} credential(s) no reported profile needs: ${over}`);
  }
  const profileCount = Object.keys(bounded.profiles).length;
  let shedProfiles = 0;
  while (shedProfiles < profileCount && reportBytes(bounded) > MAX_REPORT_BYTES) {
    bounded = { ...bounded, profiles: Object.fromEntries(Object.entries(bounded.profiles).slice(0, -1)) };
    shedProfiles += 1;
  }
  if (shedProfiles > 0) warnings.push(`reported ${profileCount - shedProfiles} of ${profileCount} profiles: ${over}`);
  let shedCredentials = 0;
  while (bounded.credentials.length > 0 && reportBytes(bounded) > MAX_REPORT_BYTES) {
    bounded = { ...bounded, credentials: bounded.credentials.slice(0, -1) };
    shedCredentials += 1;
  }
  if (shedCredentials > 0) warnings.push(`dropped ${shedCredentials} more credential(s): ${over}`);
  return { capabilities: bounded, warnings };
}

/** Design §3.2 over nax's JSON commands (D98-D101). Throws NaxUnavailableError when nax is missing or older than 0.83.1. */
export class NaxCapabilityProbe implements CapabilityProbe {
  constructor(private readonly deps: NaxProbeDeps) {}

  async probe(): Promise<ProbeResult> {
    const empty = await (this.deps.makeEmptyDir ?? makeEmptyDir)();
    try {
      const version = await readNaxVersion(this.deps.nax, empty.dir);
      const [scan, base, sandbox, protocols, tools] = await Promise.all([
        this.scanProfiles(empty.dir), this.baseInteraction(empty.dir), this.sandbox(empty.dir), this.protocols(), this.tools(),
      ]);
      const credentials = await this.credentials(empty.dir, scan.providers);
      const bounded = boundReport({
        nax: { version, protocols },
        sandbox: { ...sandbox, probedAt: this.deps.now().toISOString() },
        profiles: scan.profiles,
        credentials: credentials.list,
        tools,
        executors: ['host'],
        ...(relaySupported(version) ? { approvals: { relay: true as const } } : {}),
        ...(base.check ? { interaction: base.check } : {}),
      });
      return { capabilities: bounded.capabilities, warnings: [...base.warnings, ...scan.warnings, ...credentials.warnings, ...bounded.warnings] };
    } finally {
      await empty.remove();
    }
  }

  private async scanProfiles(cwd: string): Promise<ProfileScan> {
    const listed = await listProfileNames(this.deps.naxHome);
    const names = listed.names;
    const valid = names.filter((name) => PROFILE_NAME.test(name));
    const invalid = names.filter((name) => !PROFILE_NAME.test(name));
    const resolved = await mapLimit(valid.slice(0, MAX_PROFILES), PROFILE_CONCURRENCY, (name) => this.resolveProfile(cwd, name));
    const good = resolved.flatMap((r) => ('needs' in r ? [r] : []));
    const quoted = invalid.slice(0, 5).map((name) => JSON.stringify(name.slice(0, 64))).join(', ');
    return {
      profiles: Object.fromEntries(good.map((r) => [r.name, r.needs])),
      providers: [...new Set(good.flatMap((r) => r.needs.providers))].sort(),
      warnings: [
        ...(listed.warning === null ? [] : [listed.warning]),
        ...(invalid.length > 0 ? [`skipped ${invalid.length} profile file(s) whose names koda cannot carry: ${quoted}`] : []),
        ...(valid.length > MAX_PROFILES ? [`reported the first ${MAX_PROFILES} of ${valid.length} profiles by name`] : []),
        ...resolved.flatMap((r) => ('error' in r ? [`profile ${r.name} skipped: ${r.error}`] : [])),
        ...good.flatMap((r) => (r.warning === undefined ? [] : [r.warning])),
      ],
    };
  }

  private async resolveProfile(cwd: string, name: string): Promise<Resolved> {
    const json = parseNaxJson(await this.deps.nax.run(['config', '-d', cwd, '--profile', name, '--json'], { cwd }));
    if (!json.ok) return { name, error: json.code };
    const requirements = parseRequirements(json.value);
    if (!requirements) return { name, error: 'NAX_OUTPUT_UNPARSEABLE' };
    if (requirements.providers.length > MAX_PROVIDERS_PER_PROFILE) return { name, error: 'TOO_MANY_PROVIDERS' };
    const interaction = parseInteraction(json.value);
    const needs = toProfileNeeds(requirements, interaction?.check);
    return interaction && !interaction.check.ok ? { name, needs, warning: interactionWarning(`profile ${name}`, interaction) } : { name, needs };
  }

  /** #207 spec §3.2: the base config (no profile) is what a job dispatched with no profiles runs on. */
  private async baseInteraction(cwd: string): Promise<{ readonly check?: InteractionCheck; readonly warnings: readonly string[] }> {
    const json = parseNaxJson(await this.deps.nax.run(['config', '-d', cwd, '--json'], { cwd }));
    if (!json.ok) return { warnings: [`base config resolve failed (${json.code})`] };
    const interaction = parseInteraction(json.value);
    if (!interaction) return { warnings: [] };
    return { check: interaction.check, warnings: interaction.check.ok ? [] : [interactionWarning('the base config', interaction)] };
  }

  /** D99: needed providers first (one nax did not list is unavailable), then the rest by id; at most 64. */
  private async credentials(cwd: string, needed: readonly string[]): Promise<{ list: RunnerCredential[]; warnings: string[] }> {
    const json = parseNaxJson(await this.deps.nax.run(['auth', 'list', '--json', ...needed], { cwd }));
    const parsed = json.ok ? parseAuthList(json.value) : null;
    if (!parsed) {
      const code = json.ok ? 'NAX_OUTPUT_UNPARSEABLE' : json.code;
      return { list: needed.slice(0, MAX_CREDENTIALS).map(unavailableCredential), warnings: [`nax auth list failed (${code}); needed providers reported unavailable`] };
    }
    const byId = new Map(parsed.credentials.map((c) => [c.providerId, c] as const));
    const all = [
      ...needed.map((id) => byId.get(id) ?? unavailableCredential(id)),
      ...[...byId.values()].filter((c) => !needed.includes(c.providerId)).sort(byProviderId),
    ];
    return {
      list: all.slice(0, MAX_CREDENTIALS),
      warnings: [
        ...(parsed.skipped > 0 ? [`nax auth list: skipped ${parsed.skipped} malformed row(s)`] : []),
        ...(all.length > MAX_CREDENTIALS ? [`reported ${MAX_CREDENTIALS} of ${all.length} credentials (needed providers first)`] : []),
      ],
    };
  }

  private async sandbox(cwd: string): Promise<{ available: boolean; error?: string }> {
    const json = parseNaxJson(await this.deps.nax.run(['sandbox', 'probe', '--json'], { cwd }));
    const parsed = json.ok ? parseSandboxProbe(json.value) : null;
    return parsed ?? { available: false, error: `nax sandbox probe failed: ${json.ok ? 'NAX_OUTPUT_UNPARSEABLE' : json.code}` };
  }

  private async protocols(): Promise<NaxProtocol[]> {
    return (await this.deps.toolWorks('acpx')) ? ['native', 'acp'] : ['native'];
  }

  private async tools(): Promise<RunnerCapabilities['tools']> {
    const [git, gh, glab] = await Promise.all(['git', 'gh', 'glab'].map((tool) => this.deps.toolWorks(tool)));
    return { git, gh, glab };
  }
}
