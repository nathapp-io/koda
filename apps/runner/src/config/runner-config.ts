import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { NaxProtocol, ProfileNeeds, RunnerCredential, RunnerExecutor } from '@nathapp/fleet-protocol';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface StaticCapabilities {
  readonly nax: { version: string; protocols: NaxProtocol[] };
  readonly sandbox: { available: boolean; error?: string };
  readonly profiles: Record<string, ProfileNeeds>;
  readonly credentials: RunnerCredential[];
  readonly tools: { git: boolean; gh: boolean; glab: boolean };
  readonly executors: RunnerExecutor[];
}

export interface RunnerConfig {
  readonly serverUrl: string;
  readonly allowInsecureHttp: boolean;
  readonly workspaceRoot: string;
  readonly labels: readonly string[];
  readonly naxCommand: readonly string[];
  readonly naxHome: string;
  readonly jobRetentionDays: number;
  readonly capabilities: StaticCapabilities;
}

export interface RunnerHome {
  readonly dir: string;
  readonly configPath: string;
  readonly identityPath: string;
  readonly journalPath: string;
}

/** Same rule as the server's runner labels (apps/api/src/fleet/runners/dto/create-enrollment.dto.ts). */
const LABEL = /^[a-z0-9][a-z0-9._-]{0,31}$/;
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export function resolveHome(env: NodeJS.ProcessEnv, override?: string): RunnerHome {
  const dir = override ?? env['KODA_RUNNER_HOME'] ?? join(homedir(), '.koda-runner');
  return { dir, configPath: join(dir, 'runner.json'), identityPath: join(dir, 'identity.json'), journalPath: join(dir, 'journal.db') };
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}

function parseServerUrl(value: unknown, allowInsecureHttp: boolean): string {
  if (typeof value !== 'string') throw new ConfigError('serverUrl must be a string');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError('serverUrl is not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ConfigError('serverUrl must be http or https');
  if (url.username || url.password) throw new ConfigError('serverUrl must not carry credentials');
  if (url.search || url.hash) throw new ConfigError('serverUrl must not carry a query or fragment');
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname) && !allowInsecureHttp) {
    throw new ConfigError('serverUrl must be https (loopback hosts, or allowInsecureHttp, may use http)');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

const CREDENTIAL_KEYS = new Set(['providerId', 'available', 'stored', 'exec', 'ambient']);
const STORED_KEYS = new Set(['kind', 'expires', 'expired']);

/**
 * Local shape check of one `capabilities.credentials` entry against `RunnerCredential` (the server validator,
 * apps/api/src/fleet/common/capabilities.ts, rejects the whole report otherwise, and a bad block would then be
 * discovered only as a 400 on the first sync). `stored` is required: an object or null.
 */
function parseCredential(c: unknown, i: number): RunnerCredential {
  const where = `capabilities.credentials[${i}]`;
  if (!isObj(c) || typeof c.providerId !== 'string' || c.providerId === '' || typeof c.available !== 'boolean' || typeof c.ambient !== 'boolean') {
    throw new ConfigError(`${where} needs providerId, available and ambient`);
  }
  if (Object.keys(c).some((k) => !CREDENTIAL_KEYS.has(k))) throw new ConfigError(`${where} has unexpected fields (never put a key or token in runner.json)`);
  if (c.exec !== undefined && c.exec !== 'served' && c.exec !== 'declined' && c.exec !== 'error') throw new ConfigError(`${where}.exec must be served, declined or error`);
  const stored = c.stored;
  if (stored !== null) {
    if (!isObj(stored) || (stored.kind !== 'api-key' && stored.kind !== 'oauth') || typeof stored.expired !== 'boolean' ||
      (stored.expires !== undefined && (typeof stored.expires !== 'string' || Number.isNaN(Date.parse(stored.expires)))) ||
      Object.keys(stored).some((k) => !STORED_KEYS.has(k))) {
      throw new ConfigError(`${where}.stored must be null or { kind: "api-key"|"oauth", expires?, expired }`);
    }
  }
  return {
    providerId: c.providerId,
    available: c.available,
    stored: stored === null ? null : { kind: (stored as Obj).kind as 'api-key' | 'oauth', ...((stored as Obj).expires !== undefined ? { expires: (stored as Obj).expires as string } : {}), expired: (stored as Obj).expired as boolean },
    ...(c.exec !== undefined ? { exec: c.exec as NonNullable<RunnerCredential['exec']> } : {}),
    ambient: c.ambient,
  };
}

function parseCredentials(value: unknown): RunnerCredential[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ConfigError('capabilities.credentials must be an array');
  if (value.length > 64) throw new ConfigError('capabilities.credentials has at most 64 entries');
  return value.map(parseCredential);
}

function parseCapabilities(value: unknown): StaticCapabilities {
  if (!isObj(value)) throw new ConfigError('capabilities is required');
  const { nax, sandbox, profiles, credentials, tools, executors } = value;
  if (!isObj(nax) || typeof nax.version !== 'string' || nax.version === '' || !Array.isArray(nax.protocols) || nax.protocols.length === 0 ||
    !nax.protocols.every((p) => p === 'native' || p === 'acp')) throw new ConfigError('capabilities.nax needs a version and at least one protocol');
  if (!isObj(sandbox) || typeof sandbox.available !== 'boolean') throw new ConfigError('capabilities.sandbox.available must be a boolean');
  if (!isObj(tools) || typeof tools.git !== 'boolean' || typeof tools.gh !== 'boolean' || typeof tools.glab !== 'boolean') {
    throw new ConfigError('capabilities.tools needs git, gh and glab booleans');
  }
  if (!Array.isArray(executors) || executors.length === 0 || !executors.every((e) => e === 'host')) throw new ConfigError('capabilities.executors must be ["host"]');
  if (profiles !== undefined && !isObj(profiles)) throw new ConfigError('capabilities.profiles must be an object');
  return {
    nax: { version: nax.version, protocols: [...(nax.protocols as NaxProtocol[])] },
    sandbox: { available: sandbox.available, ...(typeof sandbox.error === 'string' ? { error: sandbox.error } : {}) },
    profiles: { ...((profiles as Record<string, ProfileNeeds> | undefined) ?? {}) },
    credentials: parseCredentials(credentials),
    tools: { git: tools.git, gh: tools.gh, glab: tools.glab },
    executors: ['host'],
  };
}

export function parseRunnerConfig(raw: unknown, env: NodeJS.ProcessEnv): RunnerConfig {
  if (!isObj(raw)) throw new ConfigError('runner.json must be a JSON object');
  const allowInsecureHttp = raw.allowInsecureHttp === true;
  if (typeof raw.workspaceRoot !== 'string' || !isAbsolute(raw.workspaceRoot)) throw new ConfigError('workspaceRoot must be an absolute path');
  const labels = raw.labels ?? [];
  if (!Array.isArray(labels) || labels.length > 20 || !labels.every((l) => typeof l === 'string' && LABEL.test(l))) {
    throw new ConfigError('labels must be at most 20 lowercase labels');
  }
  const naxCommand = raw.naxCommand ?? ['nax'];
  if (!Array.isArray(naxCommand) || naxCommand.length === 0 || naxCommand.length > 8 || !naxCommand.every((c) => typeof c === 'string' && c.length > 0)) {
    throw new ConfigError('naxCommand must be 1-8 non-empty strings');
  }
  const naxHome = raw.naxHome ?? env['NAX_GLOBAL_CONFIG_DIR'] ?? join(homedir(), '.nax');
  if (typeof naxHome !== 'string' || !isAbsolute(naxHome)) throw new ConfigError('naxHome must be an absolute path');
  const retention = raw.jobRetentionDays ?? 7;
  if (!Number.isInteger(retention) || (retention as number) < 1 || (retention as number) > 365) throw new ConfigError('jobRetentionDays must be 1-365');
  return {
    serverUrl: parseServerUrl(raw.serverUrl, allowInsecureHttp),
    allowInsecureHttp,
    workspaceRoot: raw.workspaceRoot,
    labels: [...(labels as string[])],
    naxCommand: [...(naxCommand as string[])],
    naxHome,
    jobRetentionDays: retention as number,
    capabilities: parseCapabilities(raw.capabilities),
  };
}

export async function loadRunnerConfig(path: string, env: NodeJS.ProcessEnv): Promise<RunnerConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new ConfigError(`cannot read ${path}; run "koda-runner enroll" first`);
  }
  try {
    return parseRunnerConfig(JSON.parse(text), env);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`${path} is not valid JSON`);
  }
}
