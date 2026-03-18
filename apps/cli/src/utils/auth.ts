import { getConfig } from '../config';

export interface AuthResolution {
  apiKey: string;
  apiUrl: string;
}

export function resolveAuth(options: {
  apiKey?: string;
  apiUrl?: string;
}): AuthResolution {
  const config = getConfig();

  const apiKey = options.apiKey || process.env.KODA_API_KEY || config.apiKey || '';

  const apiUrl =
    options.apiUrl ||
    process.env.KODA_API_URL ||
    config.apiUrl ||
    'http://localhost:3100/api';

  return { apiKey, apiUrl };
}
