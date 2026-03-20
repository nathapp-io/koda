import { setConfig } from '../config';
import { configureClient } from '../client';

export interface LoginResult {
  success: boolean;
  message: string;
}

export async function loginCommand(
  apiKey: string,
  apiUrl: string | undefined,
  _options: Record<string, unknown>
): Promise<LoginResult> {
  if (!apiKey) {
    throw new Error('API key is required');
  }

  const url = apiUrl || 'http://localhost:3100/api';

  // Validate API key by calling /agents/me
  const client = configureClient(url, apiKey);
  try {
    await client.get('/agents/me');
  } catch (error) {
    throw new Error('Invalid API key');
  }

  const config: Record<string, string> = { apiKey, apiUrl: url };
  setConfig(config as Parameters<typeof setConfig>[0]);

  return {
    success: true,
    message: 'Login successful. Credentials saved.',
  };
}
