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
    let parsed: unknown = undefined;
    try {
      const text = await response.text();
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      // The timeout signal bounds the whole exchange, not just the fetch: a provider that
      // stalls or resets mid-body (or answers unparseably) must map to provider_unreachable
      // instead of leaking a raw abort error (plan D8, spec §7.1 Review Focus 4).
      throw new RepoCheckException('provider_unreachable');
    }
    return { status: response.status, body: parsed };
  }
}
