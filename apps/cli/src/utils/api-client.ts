import { client } from '../generated/client.gen';

/**
 * Point the generated client at the API host and authenticate it.
 *
 * `baseUrl` must be the bare host (no /api suffix) — SDK request paths
 * already include the /api prefix. The Authorization header is only set
 * when an API key is given (public endpoints like register run without).
 */
export function configureApiClient(baseUrl: string, apiKey?: string): void {
  client.setConfig({
    baseUrl,
    ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
  });
}
