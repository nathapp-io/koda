import Conf from 'conf';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { promises as fs } from 'fs';

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
  apiUrl?: string;
  apiKey?: string;
  profile?: string;
  [key: string]: unknown;
}

export interface ResolvedContext {
  projectSlug: string | undefined;
  apiKey: string;
  apiUrl: string;
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

  const profileName = projectConfig?.profile;
  const profile = profileName ? globalConfig.profiles[profileName] : undefined;

  const apiUrl =
    flags.apiUrl ??
    projectConfig?.apiUrl ??
    profile?.apiUrl ??
    (globalConfig.apiUrl || DEFAULT_API_URL);

  const apiKey =
    flags.apiKey ??
    projectConfig?.apiKey ??
    profile?.apiKey ??
    globalConfig.apiKey ??
    '';

  const projectSlug = flags.projectSlug ?? projectConfig?.projectSlug;

  return { projectSlug, apiKey, apiUrl };
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

export function setProfile(name: string, profile: Profile): void {
  const profiles = (store.get('profiles') as Record<string, Profile>) || {};
  store.set('profiles', { ...profiles, [name]: profile });
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
}

export async function findProjectConfig(dir?: string, deps: ConfigDeps = _configDeps): Promise<ProjectConfig | null> {
  let currentDir = dir || process.cwd();
  let parentDir = dirname(currentDir);

  while (parentDir !== currentDir) {
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
