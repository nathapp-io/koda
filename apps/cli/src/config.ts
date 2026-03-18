import Conf from 'conf';

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
  projectName: 'koda',
  schema,
  fileDescriptor: 0o600, // restrictive permissions
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
  if (!apiKey || apiKey.length < 8) {
    return '****';
  }
  const visible = apiKey.slice(0, 8);
  return `${visible}${'*'.repeat(Math.max(4, apiKey.length - 8))}`;
}
