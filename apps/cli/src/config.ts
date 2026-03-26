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
};

const store = new Conf({
  cwd: join(homedir(), '.koda'),
  configName: 'config',
  schema,
});

export interface Config {
  apiKey: string;
  apiUrl: string;
}

export interface ProjectConfig {
  projectSlug: string;
  [key: string]: unknown;
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

export async function findProjectConfig(dir?: string, deps: ConfigDeps = _configDeps): Promise<ProjectConfig | null> {
  let currentDir = dir || process.cwd();

  while (true) {
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

    // Check if we've reached the root directory
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      // We're at the root
      return null;
    }

    currentDir = parentDir;
  }
}
