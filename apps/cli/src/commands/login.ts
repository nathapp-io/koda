import { setConfig } from '../config';
import { OpenAPI } from '../generated/core/OpenAPI';
import { agentsControllerFindMe } from '../generated';

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

  // Strip /api suffix so OpenAPI.BASE is set to the bare host
  const url = (apiUrl ?? 'http://localhost:3100').replace(/\/api\/?$/, '');

  OpenAPI.BASE = url;
  OpenAPI.TOKEN = apiKey;

  try {
    await agentsControllerFindMe();
  } catch {
    throw new Error('Invalid API key');
  }

  const config: Record<string, string> = { apiKey, apiUrl: url };
  setConfig(config as Parameters<typeof setConfig>[0]);

  return {
    success: true,
    message: 'Login successful. Credentials saved.',
  };
}
