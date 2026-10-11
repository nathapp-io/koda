import type { InteractionCheck, NaxProtocol, ProfileNeeds, RunnerCapabilities, RunnerCredential } from './protocol';
import { MODEL_ID_RE, THREAD_LIMITS, type ThreadAgent, type ThreadBackends } from './thread-jobs';

export const MAX_CAPABILITIES_BYTES = 65_536;
/** #161: bounded names (same rule as dispatch profiles, Task 11) and bounded collections. */
export const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const MAX_PROFILES = 64;
export const MAX_PROVIDERS_PER_PROFILE = 16;
export const MAX_CREDENTIALS = 64;
const PROTOCOLS: readonly NaxProtocol[] = ['acp', 'native'];
const EXECUTORS = ['host'] as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

const INTERACTION_KEYS = new Set(['ok', 'plugin', 'code']);
const INTERACTION_CODE_RE = /^[A-Z0-9_]{1,64}$/;
const MAX_PLUGIN_NAME = 64;

/**
 * The core carries no framework, so the runner's merge gate can import it directly and prove a real report is accepted
 * without pulling in this app's dependency graph (`apps/runner/test/live/nax-probe.live.spec.ts`). `capabilities.ts`
 * wraps it in the NestJS exception the API answers with.
 */
export class CapabilityValidationError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'CapabilityValidationError';
  }
}

function fail(reason: string): never {
  throw new CapabilityValidationError(reason);
}

/** #207, plan D271 style: strict, since a report the API accepts is what placement trusts. */
function parseInteraction(v: unknown, where: string): InteractionCheck {
  if (!isObj(v) || Object.keys(v).some((k) => !INTERACTION_KEYS.has(k)) || !isBool(v.ok)) fail(where);
  const check = v as Obj;
  const plugin = check.plugin;
  if (!(plugin === null || (typeof plugin === 'string' && plugin.length > 0 && plugin.length <= MAX_PLUGIN_NAME))) fail(where);
  if (check.code !== undefined && !(typeof check.code === 'string' && INTERACTION_CODE_RE.test(check.code))) fail(where);
  return { ok: check.ok as boolean, plugin: plugin as string | null, ...(check.code !== undefined ? { code: check.code as string } : {}) };
}

function parseProfile(name: string, v: unknown): ProfileNeeds {
  if (!PROFILE_NAME_RE.test(name)) fail(`profile name ${name.slice(0, 70)}`);
  if (!isObj(v) || !PROTOCOLS.includes(v.protocol as NaxProtocol) || !isStrArray(v.providers) || !isBool(v.sandbox)) {
    fail(`profile ${name}`);
  }
  if ((v.providers as string[]).length > MAX_PROVIDERS_PER_PROFILE) fail(`profile ${name} providers`);
  const interaction = (v as Obj).interaction;
  return {
    protocol: v.protocol as NaxProtocol,
    providers: [...(v.providers as string[])],
    sandbox: v.sandbox as boolean,
    ...(interaction !== undefined ? { interaction: parseInteraction(interaction, `profile ${name} interaction`) } : {}),
  };
}

const THREAD_AGENTS: readonly ThreadAgent[] = ['claude', 'codex'];

/** Fleet S5a §3: strict like approvals and configJobs. Exactly the keys native and acp; both arrays unique and bounded. */
function parseThreadBackends(v: unknown): ThreadBackends {
  if (!isObj(v) || Object.keys(v).length !== 2 || !Array.isArray(v.native) || !Array.isArray(v.acp)) fail('threadBackends');
  const native = v.native as unknown[];
  const acp = v.acp as unknown[];
  if (
    native.length > THREAD_LIMITS.maxNativeModels || new Set(native).size !== native.length ||
    !native.every((id) => typeof id === 'string' && MODEL_ID_RE.test(id))
  ) fail('threadBackends');
  if (
    acp.length > THREAD_LIMITS.maxAcpAgents || new Set(acp).size !== acp.length ||
    !acp.every((agent) => THREAD_AGENTS.includes(agent as ThreadAgent))
  ) fail('threadBackends');
  return { native: [...(native as string[])], acp: [...(acp as ThreadAgent[])] };
}

const CREDENTIAL_KEYS = new Set(['providerId', 'available', 'stored', 'exec', 'ambient']);
const STORED_KEYS = new Set(['kind', 'expires', 'expired']);
const STORED_KINDS: readonly string[] = ['api-key', 'oauth'];
const EXEC_STATUSES: readonly string[] = ['served', 'declined', 'error'];

function parseStored(v: unknown, i: number): RunnerCredential['stored'] {
  if (v === null) return null;
  // `stored` is required on the wire: an object or an explicit null. undefined (absent) is rejected.
  if (
    v === undefined || !isObj(v) || !STORED_KINDS.includes(v.kind as string) || !isBool(v.expired) ||
    (v.expires !== undefined && (!isStr(v.expires) || Number.isNaN(Date.parse(v.expires))))
  ) fail(`credential ${i} stored`);
  const stored = v as Obj;
  if (Object.keys(stored).some((k) => !STORED_KEYS.has(k))) fail(`credential ${i} stored has unexpected fields`);
  return {
    kind: stored.kind as 'api-key' | 'oauth',
    ...(stored.expires !== undefined ? { expires: stored.expires as string } : {}),
    expired: stored.expired as boolean,
  };
}

function parseCredential(c: unknown, i: number): RunnerCredential {
  if (!isObj(c) || !isStr(c.providerId) || !isBool(c.available) || !isBool(c.ambient)) fail(`credential ${i}`);
  const cred = c as Obj;
  if (Object.keys(cred).some((k) => !CREDENTIAL_KEYS.has(k))) fail(`credential ${i} has unexpected fields`);
  if (cred.exec !== undefined && !EXEC_STATUSES.includes(cred.exec as string)) fail(`credential ${i} exec`);
  return {
    providerId: cred.providerId as string,
    available: cred.available as boolean,
    stored: parseStored(cred.stored, i),
    ...(cred.exec !== undefined ? { exec: cred.exec as RunnerCredential['exec'] } : {}),
    ambient: cred.ambient as boolean,
  };
}

/** Validates a runner's self-reported capabilities (untrusted input, spec §2.1) and returns a clean copy. */
export function parseCapabilitiesCore(raw: unknown): RunnerCapabilities {
  if (!isObj(raw)) fail('not an object');
  if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > MAX_CAPABILITIES_BYTES) fail('too large');
  const { nax, sandbox, profiles, credentials, tools, executors, approvals, interaction, configJobs, threadBackends } = raw;

  if (
    !isObj(nax) || !isStr(nax.version) || !Array.isArray(nax.protocols) || nax.protocols.length === 0 ||
    !nax.protocols.every((p) => PROTOCOLS.includes(p)) || new Set(nax.protocols).size !== nax.protocols.length
  ) fail('nax');
  if (!isObj(sandbox) || !isBool(sandbox.available) || !isStr(sandbox.probedAt) || (sandbox.error !== undefined && typeof sandbox.error !== 'string')) fail('sandbox');
  if (!isObj(profiles)) fail('profiles');
  if (Object.keys(profiles).length > MAX_PROFILES) fail('too many profiles');
  if (!Array.isArray(credentials)) fail('credentials');
  if (credentials.length > MAX_CREDENTIALS) fail('too many credentials');
  if (!isObj(tools) || !isBool(tools.git) || !isBool(tools.gh) || !isBool(tools.glab)) fail('tools');
  if (!Array.isArray(executors) || !executors.every((e) => (EXECUTORS as readonly unknown[]).includes(e))) fail('executors');
  // Plan D271: strict like every other field; only exactly { relay: true } is meaningful.
  if (approvals !== undefined && !(isObj(approvals) && approvals.relay === true && Object.keys(approvals).length === 1)) fail('approvals');
  // Fleet S3 §3: strict like approvals; only exactly `true` is meaningful.
  if (configJobs !== undefined && configJobs !== true) fail('configJobs');

  const parsedCredentials = credentials.map(parseCredential);

  return {
    nax: { version: nax.version as string, protocols: [...(nax.protocols as NaxProtocol[])] },
    sandbox: {
      available: sandbox.available as boolean,
      probedAt: sandbox.probedAt as string,
      ...(sandbox.error !== undefined ? { error: sandbox.error as string } : {}),
    },
    profiles: Object.fromEntries(Object.entries(profiles).map(([name, v]) => [name, parseProfile(name, v)])),
    credentials: parsedCredentials,
    tools: { git: tools.git as boolean, gh: tools.gh as boolean, glab: tools.glab as boolean },
    executors: [...(executors as Array<'host'>)],
    ...(approvals !== undefined ? { approvals: { relay: true as const } } : {}),
    ...(interaction !== undefined ? { interaction: parseInteraction(interaction, 'interaction') } : {}),
    ...(configJobs === true ? { configJobs: true as const } : {}),
    ...(threadBackends !== undefined ? { threadBackends: parseThreadBackends(threadBackends) } : {}),
  };
}
