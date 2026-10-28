import { client } from '../generated/client.gen';
import { ApprovalPendingError, type ApprovalPendingRequest } from './approval-pending';

let approvalInterceptorInstalled = false;

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

  if (!approvalInterceptorInstalled) {
    client.interceptors.response.use(async (response) => {
      if (response.status !== 202) {
        return response;
      }

      const body = (await response.json()) as { ret: number; data: ApprovalPendingRequest };
      throw new ApprovalPendingError(body.data);
    });
    approvalInterceptorInstalled = true;
  }
}
