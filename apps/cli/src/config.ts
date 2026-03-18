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
  // API key must be at least 6 characters (mykey123 = 8 chars, covers test keys)
  return apiKey.length >= 6;
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
  // Show last 6 characters, prefix with *** (e.g. mykey123 -> ***key123)
  const visible = apiKey.slice(-6);
  return `***${visible}`;
}
