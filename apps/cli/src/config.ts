import Conf from 'conf';
import { homedir } from 'os';
import { join } from 'path';

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

  // If starts with sk-proj-, preserve that prefix and mask the rest
  if (apiKey.startsWith('sk-proj-')) {
    const suffix = apiKey.slice('sk-proj-'.length);
    // Mask the suffix with asterisks (at least 4)
    const asterisks = '*'.repeat(Math.max(4, suffix.length));
    return `sk-proj-${asterisks}`;
  }

  // For non-prefixed keys, show first character and mask the rest with at least 4 asterisks
  const firstChar = apiKey[0];
  const asterisks = '*'.repeat(Math.max(4, apiKey.length - 1));
  return `${firstChar}${asterisks}`;
}
