import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FLEET_PROTOCOL_VERSION } from '@nathapp/fleet-protocol';
import { StaticCapabilityProbe } from '../capabilities/capability-probe';
import { ConfigError, loadRunnerConfig, parseRunnerConfig, type RunnerHome, type StaticCapabilities } from '../config/runner-config';
import { errorMessage } from '../errors';
import { newBootId, readIdentity, writeIdentity } from '../identity/identity-store';
import { NetworkError, ServerError, type ServerClient } from '../sync/http';
import type { Now } from '../time';
import { DAEMON_VERSION } from '../version';

export class EnrollError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnrollError';
  }
}

export interface EnrollOptions {
  readonly home: RunnerHome;
  readonly server?: string;
  readonly token: string;
  readonly name?: string;
  readonly labels: readonly string[];
  readonly workspace?: string;
  readonly insecureHttp: boolean;
}

export interface EnrollDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly hostname: () => string;
  readonly platform: string;
  readonly arch: string;
  readonly which: (cmd: string) => string | null;
  readonly now: Now;
  readonly makeClient: (serverUrl: string) => Pick<ServerClient, 'enroll'>;
  readonly log: (line: string) => void;
}

export function defaultRunnerName(hostname: string): string {
  const name = hostname.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+/, '').slice(0, 63);
  return name === '' ? 'runner' : name;
}

/** D50: what a machine can honestly claim without asking nax; the operator edits runner.json for the rest. */
export function defaultCapabilities(which: (cmd: string) => string | null): StaticCapabilities {
  return {
    nax: { version: 'unknown', protocols: ['native'] }, sandbox: { available: false }, profiles: {}, credentials: [],
    tools: { git: which('git') !== null, gh: which('gh') !== null, glab: which('glab') !== null }, executors: ['host'],
  };
}

async function exists(path: string): Promise<boolean> {
  return readFile(path).then(() => true, () => false);
}

async function ensureConfig(options: EnrollOptions, deps: EnrollDeps) {
  const { home } = options;
  if (await exists(home.configPath)) {
    const config = await loadRunnerConfig(home.configPath, deps.env);
    if (options.server && new URL(options.server).origin !== new URL(config.serverUrl).origin) {
      throw new EnrollError(`--server differs from the serverUrl in ${home.configPath}; edit or delete that file first`);
    }
    const ignored = [
      ...(options.labels.length > 0 ? ['--labels'] : []),
      ...(options.workspace ? ['--workspace'] : []),
      ...(options.insecureHttp ? ['--insecure-http'] : []),
    ];
    if (ignored.length > 0) deps.log(`warning: ${ignored.join(', ')} ignored: ${home.configPath} already exists and is not modified; edit that file instead`);
    return config;
  }
  if (!options.server) throw new EnrollError('--server <url> is required (no runner.json exists yet)');
  const raw = {
    serverUrl: options.server,
    ...(options.insecureHttp ? { allowInsecureHttp: true } : {}),
    workspaceRoot: options.workspace ?? join(home.dir, 'workspace'),
    labels: [...options.labels],
    naxCommand: ['nax'],
    capabilities: defaultCapabilities(deps.which),
  };
  const config = parseRunnerConfig(raw, deps.env);
  await mkdir(home.dir, { recursive: true, mode: 0o700 });
  await writeFile(home.configPath, `${JSON.stringify(raw, null, 2)}\n`);
  deps.log(`wrote ${home.configPath}; edit its "capabilities" block to declare nax version, profiles and credentials`);
  return config;
}

function explain(error: unknown, name: string): EnrollError {
  if (error instanceof ServerError) {
    if (error.status === 401) return new EnrollError('the enrollment token is invalid, used or expired');
    if (error.status === 409) return new EnrollError(`a runner named "${name}" already exists; pass --name to choose another`);
    if (error.status === 426) return new EnrollError(`the server does not support this runner: ${error.message}`);
    if (error.status === 400) return new EnrollError(`the server rejected the request: ${error.message}`);
    return new EnrollError(`the server answered ${error.status}: ${error.message}`);
  }
  if (error instanceof NetworkError) return new EnrollError(`cannot reach the server: ${error.message}`);
  return new EnrollError(errorMessage(error));
}

export async function enrollRunner(options: EnrollOptions, deps: EnrollDeps): Promise<{ runnerId: string; name: string }> {
  const { home } = options;
  if (await readIdentity(home.identityPath)) {
    throw new EnrollError(`this machine is already enrolled; delete ${home.identityPath} to enroll again (the old runner stays registered until an admin removes it)`);
  }
  if (deps.platform !== 'darwin' && deps.platform !== 'linux') throw new EnrollError(`unsupported platform ${deps.platform}`);
  if (deps.arch !== 'arm64' && deps.arch !== 'x64') throw new EnrollError(`unsupported platform architecture ${deps.arch}`);
  let config;
  try {
    config = await ensureConfig(options, deps);
  } catch (error) {
    if (error instanceof ConfigError) throw new EnrollError(error.message);
    throw error;
  }
  const name = options.name ?? defaultRunnerName(deps.hostname());
  const capabilities = await new StaticCapabilityProbe(config.capabilities, deps.now).probe();
  let enrolled: { runnerId: string; apiKey: string };
  try {
    enrolled = await deps.makeClient(config.serverUrl).enroll({
      enrollmentToken: options.token, name, os: deps.platform, arch: deps.arch, daemonVersion: DAEMON_VERSION,
      protocolVersion: FLEET_PROTOCOL_VERSION, bootId: newBootId(), labels: [...config.labels], capabilities,
    });
  } catch (error) {
    throw explain(error, name);
  }
  await writeIdentity(home.identityPath, { runnerId: enrolled.runnerId, apiKey: enrolled.apiKey, serverUrl: config.serverUrl, name, enrolledAt: deps.now().toISOString() });
  deps.log(`enrolled as ${name} (${enrolled.runnerId}); start it with: koda-runner run`);
  return { runnerId: enrolled.runnerId, name };
}
