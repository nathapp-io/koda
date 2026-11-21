import { setConfig } from '../config';
import { configureApiClient } from '../utils/api-client';
import { agentsControllerFindMe } from '../generated';
import { getStatusAndMessage } from '../utils/error';

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
  const url = (apiUrl || 'http://localhost:3100').replace(/\/api\/?$/, '');

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
  const { status, message } = getStatusAndMessage(err);
  if (status === 401 || status === 403) {
    return Object.assign(new Error('Invalid API key'), { status });
  }

  if (status !== undefined) {
    return Object.assign(new Error(message), { status });
  }

  // An unmapped nonzero `ret` is still a delivered API rejection, rather
  // than a transport failure. Preserve its message without a retry hint.
  const ret = (err as { ret?: unknown } | null)?.ret;
  if (typeof ret === 'number' && ret !== 0) {
    return new Error(message);
  }

  // Network-layer failures (DNS, ECONNREFUSED, timeout, …) have no API
  // status or nonzero application code and retain the connectivity diagnostic.
  const networkMessage =
    err instanceof Error ? err.message : String(err) || 'Unknown network error';
  return Object.assign(new Error(`Could not reach API: ${networkMessage}`), {
    transient: true,
  });
}
