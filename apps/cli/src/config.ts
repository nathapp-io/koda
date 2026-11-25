import Conf from 'conf';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { promises as fs, chmodSync } from 'fs';

const schema = {
  apiKey: {
    type: 'string',
    default: '',
  },
  apiUrl: {
    type: 'string',
    default: '',
  },
  profiles: {
    type: 'object',
    default: {},
  },
};

const store = new Conf({
  cwd: join(homedir(), '.koda'),
  configName: 'config',
  schema,
});

export function getGlobalConfigPath(): string {
  return store.path;
}

// SEC-2: `conf` writes with default mode 0o666 (umask → 0o644), which puts the
// API key at ~/.koda/config.json within reach of every local user on
// multi-user workstations. Force 0600 after every write and defensively on read.
function secureConfigFile(): void {
  const path = (store as { path?: string }).path;
  if (!path) return;
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort: if the file does not exist yet (first write), skip.
  }
}

export interface Profile {
  apiKey: string;
  apiUrl: string;
}

export interface Config {
  apiKey: string;
  apiUrl: string;
  profiles: Record<string, Profile>;
}

export interface ProjectConfig {
  projectSlug?: string;
  defaults?: {
    type?: string;
    priority?: string;
  };
  apiUrl?: string;
  apiKey?: string;
  profile?: string;
  [key: string]: unknown;
}

export type CredentialSource = 'flag' | 'environment' | 'profile' | 'global' | 'none';

export interface CredentialProvenance {
  source: CredentialSource;
  key: string;
  profileName?: string;
  owningUrl?: string;
}

export interface ResolvedContext {
  projectSlug: string | undefined;
  apiKey: string;
  apiUrl: string;
  credential: CredentialProvenance;
  defaults?: ProjectConfig['defaults'];
}

export type LogoutCleanup = 'global' | { profileName: string } | 'none';

/**
 * Normalize an API base URL for the ownership comparison, keeping path prefixes
 * and nondefault ports while treating trailing slashes and the optional trailing
 * `/api` as equivalent.
 *
 * Returns null for a URL that cannot be parsed. An unusable owning URL proves no
 * ownership and an unusable used URL can match nothing, so cleanup treats null as
 * a mismatch instead of letting `new URL` throw out of a successful logout.
 */
function normalizedApiBase(url: string | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const pathname = parsed.pathname.replace(/\/+$/, '').replace(/\/api$/, '').replace(/\/+$/, '');
  return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${pathname}`;
}

/** True only when both URLs are parseable and denote the same API base. */
function ownsEndpoint(usedUrl: string | undefined, owningUrl: string | undefined): boolean {
  const used = normalizedApiBase(usedUrl);
  const owned = normalizedApiBase(owningUrl);
  return used !== null && owned !== null && used === owned;
}

export function clearUsedCredential(ctx: ResolvedContext): LogoutCleanup {
  const provenance = ctx.credential;
  if (provenance.source === 'global' && provenance.owningUrl &&
      provenance.key === getConfig().apiKey &&
      ownsEndpoint(ctx.apiUrl, provenance.owningUrl)) {
    const current = getConfig();
    if (current.apiKey !== provenance.key || !ownsEndpoint(current.apiUrl || DEFAULT_API_URL, provenance.owningUrl)) return 'none';
    store.set('apiKey', '');
    secureConfigFile();
    return 'global';
  }
  if (provenance.source === 'profile' && provenance.profileName && provenance.owningUrl &&
      ownsEndpoint(ctx.apiUrl, provenance.owningUrl)) {
    const current = getConfig();
    const profile = current.profiles[provenance.profileName];
    if (!profile?.apiUrl || profile.apiKey !== provenance.key || !ownsEndpoint(profile.apiUrl, provenance.owningUrl)) return 'none';
    store.set('profiles', { ...current.profiles, [provenance.profileName]: { ...profile, apiKey: '' } });
    secureConfigFile();
    return { profileName: provenance.profileName };
  }
  return 'none';
}

export interface ResolveContextFlags {
  projectSlug?: string;
  apiKey?: string;
  apiUrl?: string;
  cwd?: string;
}

export interface ResolveContextDeps {
  findProjectConfig: (dir?: string) => Promise<ProjectConfig | null>;
  getConfig: () => Config;
}

export interface ConfigDeps {
  readFile: (path: string) => Promise<string>;
  exists: (path: string) => Promise<boolean>;
}

export const _configDeps: ConfigDeps = {
  readFile: (path: string) => fs.readFile(path, 'utf-8'),
  exists: async (path: string) => {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  },
};

export function validateApiKey(apiKey: string | undefined): boolean {
  if (!apiKey || typeof apiKey !== 'string') {
    return false;
  }
  // API key must be at least 10 characters
  return apiKey.length >= 10;
}

export function getConfig(): Config {
  secureConfigFile();
  return {
    apiKey: (store.get('apiKey') as string) || '',
    apiUrl: (store.get('apiUrl') as string) || '',
    profiles: (store.get('profiles') as Record<string, Profile>) || {},
  };
}

export function setConfig(partial: Partial<Config>): void {
  if (partial.apiKey !== undefined) {
    if (!validateApiKey(partial.apiKey)) {
      throw new Error('Invalid API key: must be at least 10 characters');
    }
    store.set('apiKey', partial.apiKey);
  }

  if (partial.apiUrl !== undefined) {
    store.set('apiUrl', partial.apiUrl);
  }

  if (partial.profiles !== undefined) {
    store.set('profiles', partial.profiles);
  }

  secureConfigFile();
}

export const _defaultResolveContextDeps: ResolveContextDeps = {
  findProjectConfig: (dir?: string) => findProjectConfig(dir),
  getConfig,
};

const DEFAULT_API_URL = 'http://localhost:3100';

export async function resolveContext(
  flags: ResolveContextFlags,
  deps: ResolveContextDeps = _defaultResolveContextDeps,
): Promise<ResolvedContext> {
  const projectConfig = await deps.findProjectConfig(flags.cwd);
  const globalConfig = deps.getConfig();

  // H10: project-local `.koda/config.json` is repo-controlled and untrusted —
  // a cloned repository must never be able to redirect API traffic or steal
  // the user's credentials. apiUrl/apiKey from project configs are ignored;
  // only projectSlug, profile and defaults are honored.
  if (projectConfig && ('apiUrl' in projectConfig || 'apiKey' in projectConfig)) {
    console.error(
      '[koda] WARNING: .koda/config.json contains apiUrl/apiKey — ignored for security (H10). Only projectSlug, profile and defaults are honored.',
    );
  }

  const profileName = projectConfig?.profile;
  const profile = profileName ? globalConfig.profiles[profileName] : undefined;

  // `||`, not `??`: an empty flag, env var or profile value means "not set".
  const apiUrl =
    flags.apiUrl ||
    process.env.KODA_API_URL ||
    profile?.apiUrl ||
    globalConfig.apiUrl ||
    DEFAULT_API_URL;

  const apiKey =
    flags.apiKey ??
    process.env.KODA_API_KEY ??
    profile?.apiKey ??
    globalConfig.apiKey ??
    '';

  const credential: CredentialProvenance = flags.apiKey !== undefined
    ? { source: 'flag', key: apiKey }
    : process.env.KODA_API_KEY !== undefined
      ? { source: 'environment', key: apiKey }
      : profileName !== undefined && profile?.apiKey !== undefined
        ? { source: 'profile', key: apiKey, profileName, owningUrl: profile.apiUrl || undefined }
        : globalConfig.apiKey !== undefined && globalConfig.apiKey !== ''
          ? { source: 'global', key: apiKey, owningUrl: globalConfig.apiUrl || DEFAULT_API_URL }
          : { source: 'none', key: apiKey };

  const projectSlug = flags.projectSlug ?? process.env.KODA_PROJECT_SLUG ?? projectConfig?.projectSlug;

  return { projectSlug, apiKey, apiUrl, credential, defaults: projectConfig?.defaults };
}

export function maskApiKey(apiKey: string): string {
  if (!apiKey || apiKey.length < 4) {
    return '****';
  }

  // If key starts with 'sk-proj-', preserve that prefix and mask the rest
  if (apiKey.startsWith('sk-proj-')) {
    const prefix = 'sk-proj-';
    const rest = apiKey.slice(prefix.length);
    // Mask all characters in the rest with asterisks
    const masked = '*'.repeat(Math.max(4, rest.length));
    return `${prefix}${masked}`;
  }

  // For other keys, show last 6 characters with *** prefix
  const visible = apiKey.slice(-6);
  return `***${visible}`;
}

export function clearApiKey(): void {
  store.delete('apiKey');
  secureConfigFile();
}

export function setProfile(name: string, profile: Profile): void {
  const profiles = (store.get('profiles') as Record<string, Profile>) || {};
  store.set('profiles', { ...profiles, [name]: profile });
  secureConfigFile();
}

export function getProfiles(): Array<{ name: string; apiUrl: string }> {
  const profiles = (store.get('profiles') as Record<string, Profile>) || {};
  return Object.entries(profiles).map(([name, p]) => ({ name, apiUrl: p.apiUrl }));
}

export function removeProfile(name: string): void {
  const profiles = (store.get('profiles') as Record<string, Profile>) || {};
  if (!(name in profiles)) {
    throw new Error(`Profile not found: ${name}`);
  }
  const { [name]: _removed, ...remaining } = profiles;
  store.set('profiles', remaining);
  secureConfigFile();
}

export async function findProjectConfig(dir?: string, deps: ConfigDeps = _configDeps): Promise<ProjectConfig | null> {
  let currentDir = dir || process.cwd();
  let parentDir = dirname(currentDir);

  while (parentDir !== currentDir) {
    // H10: homedir ceiling — `~/.koda/config.json` is the user's global config
    // (credentials), not a project config. Stop the walk-up before the home
    // directory is considered so it is never returned as a project config.
    if (currentDir === homedir()) {
      break;
    }

    const configPath = join(currentDir, '.koda', 'config.json');

    const fileExists = await deps.exists(configPath);
    if (fileExists) {
      try {
        const content = await deps.readFile(configPath);
        const config = JSON.parse(content) as ProjectConfig;
        return config;
      } catch {
        // If JSON parsing fails, return null
        return null;
      }
    }

    currentDir = parentDir;
    parentDir = dirname(currentDir);
  }

  return null;
}
