import { Inject, Injectable } from '@nestjs/common';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { RepoCheckException } from './repo-check.exception';

/**
 * Minimal forge HTTP client: bounded by FLEET_HTTP_TIMEOUT_MS and never follows a
 * redirect, so a bearer token cannot be forwarded to another host (plan D8).
 */
@Injectable()
export class FleetHttpClient {
  constructor(@Inject(FLEET_CFG) private readonly config: Pick<IFleetConfig, 'httpTimeoutMs'>) {}

  async request(method: 'GET' | 'POST', url: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; body: unknown }> {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.config.httpTimeoutMs),
        headers: { accept: 'application/json', 'user-agent': 'koda-fleet', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new RepoCheckException('provider_unreachable');
    }
    if (response.status >= 300 && response.status < 400) throw new RepoCheckException('provider_unreachable');
    let text: string;
    try {
      text = await response.text();
    } catch {
      // The timeout signal bounds the whole exchange, not just the fetch: a provider that
      // stalls or resets mid-body maps to provider_unreachable (plan D8, spec §7.1).
      throw new RepoCheckException('provider_unreachable');
    }
    if (!text) return { status: response.status, body: undefined };
    try {
      return { status: response.status, body: JSON.parse(text) };
    } catch {
      // #160: the provider answered, but not with JSON (for example a proxy's HTML error page).
      throw new RepoCheckException('provider_error');
    }
  }
}
