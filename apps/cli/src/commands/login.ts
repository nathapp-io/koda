import { setConfig } from '../config';

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

  const config: Record<string, string> = { apiKey };
  if (apiUrl) {
    config.apiUrl = apiUrl;
  } else {
    config.apiUrl = 'http://localhost:3100/api';
  }

  setConfig(config as Parameters<typeof setConfig>[0]);

  return {
    success: true,
    message: 'Login successful. Credentials saved.',
  };
}
