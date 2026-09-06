import { setConfig } from '../config';
import { OpenAPI } from '../generated/core/OpenAPI';
import { ApiError } from '../generated/core/ApiError';
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
  } catch (err) {
    throw loginError(err);
  }

  const config: Record<string, string> = { apiKey, apiUrl: url };
  setConfig(config as Parameters<typeof setConfig>[0]);

  return {
    success: true,
    message: 'Login successful. Credentials saved.',
  };
}

/**
 * Translate whatever the upstream API rejected with into a useful error.
 *
 * CLI-05 reported that login masked every failure (network outage, DNS
 * failure, 5xx, etc.) as "Invalid API key". Only 401/403 mean the key is
 * wrong; everything else should bubble up so the user can act on the
 * actual cause.
 */
export function loginError(err: unknown): Error & { status?: number; transient?: boolean } {
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 403) {
      return Object.assign(new Error('Invalid API key'), { status: err.status });
    }
    const bodyMessage =
      err.body && typeof err.body === 'object' && 'message' in err.body
        ? String((err.body as { message?: unknown }).message)
        : undefined;
    return Object.assign(
      new Error(bodyMessage ?? err.statusText ?? err.message ?? 'API error'),
      { status: err.status },
    );
  }

  // Network-layer failure (DNS, ECONNREFUSED, timeout, …) — these don't
  // carry a status, but reporting them as "Invalid API key" would mislead
  // the user when really their network or the API itself is down.
  const networkMessage =
    err instanceof Error ? err.message : String(err) || 'Unknown network error';
  return Object.assign(new Error(`Could not reach API: ${networkMessage}`), {
    transient: true,
  });
}
