import { setConfig } from '../config';
import { configureApiClient } from '../utils/api-client';
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

  // Strip /api suffix so the client base URL is set to the bare host
  const url = (apiUrl ?? 'http://localhost:3100').replace(/\/api\/?$/, '');

  configureApiClient(url, apiKey);

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
  // The generated client throws the parsed error body for HTTP failures
  // (e.g. Nest's { statusCode, message }) and plain Errors without a status
  // for network failures. `.status` is bridged for errors that carry it
  // directly.
  const status =
    (err as { statusCode?: number } | null)?.statusCode ??
    (err as { status?: number } | null)?.status;
  if (status === 401 || status === 403) {
    return Object.assign(new Error('Invalid API key'), { status });
  }

  if (status !== undefined) {
    const rawMessage = (err as { message?: unknown } | null)?.message;
    const bodyMessage =
      typeof rawMessage === 'string'
        ? rawMessage
        : Array.isArray(rawMessage)
          ? rawMessage.map(String).join('; ')
          : undefined;
    return Object.assign(new Error(bodyMessage ?? 'API error'), { status });
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
