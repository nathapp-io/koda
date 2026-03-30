import { setConfig } from '../config';
import { OpenAPI } from '../generated/core/OpenAPI';
import { agentsControllerFindMe } from '../generated/services.gen';

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

  const baseUrl = apiUrl || 'http://localhost:3100';

  // Configure generated client with API credentials
  // OpenAPI services include /api/ in their paths, so baseUrl should NOT include it
  OpenAPI.BASE = baseUrl;
  OpenAPI.TOKEN = apiKey;

  // Validate API key by calling /api/agents/me
  try {
    await agentsControllerFindMe();
  } catch {
    throw new Error('Invalid API key');
  }

  // Save the URL with /api/ suffix for use by other commands (which use axios with generated.ts)
  const savedUrl = baseUrl.endsWith('/api') ? baseUrl : `${baseUrl}/api`;
  const config: Record<string, string> = { apiKey, apiUrl: savedUrl };
  setConfig(config as Parameters<typeof setConfig>[0]);

  return {
    success: true,
    message: 'Login successful. Credentials saved.',
  };
}
