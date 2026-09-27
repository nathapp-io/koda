import * as http from 'node:http';
import * as https from 'node:https';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { IWebhookConfig, WEBHOOK_CFG } from '../../config/webhook.config';
import { OutboundUrlGuard } from './outbound-url-guard';

/** US-004: the fixed, non-oracular delivery codes an outbox `lastError` may show. */
export type DeliveryErrorCode =
  | 'blocked_destination'
  | 'connect_failed'
  | 'timeout'
  | 'redirect_refused'
  | 'http_4xx'
  | 'http_5xx';

/**
 * The one delivery failure `OutboundHttpClient.post` throws. `message` is exactly
 * `code`, so the raw socket text can never leak into an admin-visible `lastError`.
 */
export class WebhookDeliveryError extends Error {
  constructor(readonly code: DeliveryErrorCode) {
    super(code);
    this.name = 'WebhookDeliveryError';
  }
}

/** The `lookup` error code the guard's connect-time callback raises. */
const EBLOCKED_DESTINATION = 'EBLOCKED_DESTINATION';
/** Node 22 and Bun 1.4.2 both report an aborted request (`AbortSignal.timeout`) as `ABORT_ERR`. */
const ABORT_ERR = 'ABORT_ERR';

/** Step 4: every request error collapses onto one fixed delivery code. */
function mapRequestError(error: unknown): DeliveryErrorCode {
  const errno = error as NodeJS.ErrnoException;
  if (errno?.code === EBLOCKED_DESTINATION) return 'blocked_destination';
  if (errno?.code === ABORT_ERR) return 'timeout';
  // Refused, reset, TLS, DNS: all indistinguishable to the operator, all retryable.
  return 'connect_failed';
}

/**
 * US-004: the guarded native HTTP(S) transport for webhook delivery.
 *
 * `post` never follows a redirect (a 3xx is `redirect_refused` and the `Location`
 * is never requested) and re-validates the destination with `OutboundUrlGuard`
 * before the socket is created, so a stored URL that is no longer allow-listed
 * fails as `blocked_destination` without a connection.
 */
@Injectable()
export class OutboundHttpClient {
  private readonly logger = new Logger(OutboundHttpClient.name);

  constructor(
    private readonly urlGuard: OutboundUrlGuard,
    @Inject(WEBHOOK_CFG) private readonly config: IWebhookConfig,
  ) {}

  /** Resolves on 2xx. Otherwise throws `WebhookDeliveryError`. */
  async post(url: string, headers: Record<string, string>, body: string): Promise<void> {
    let target: URL;
    try {
      target = new URL(url);
      this.urlGuard.assertStaticTarget(target);
    } catch {
      // Step 1: a malformed URL or any `OutboundUrlRejection` is a blocked destination.
      throw new WebhookDeliveryError('blocked_destination');
    }

    let status: number;
    try {
      status = await this.send(target, headers, body);
    } catch (error) {
      this.logRawFailure(error, target.host);
      throw new WebhookDeliveryError(mapRequestError(error));
    }

    // Step 3: only the status class matters; the body has already been discarded.
    if (status >= 200 && status <= 299) return;
    if (status >= 300 && status <= 399) throw new WebhookDeliveryError('redirect_refused');
    if (status >= 400 && status <= 499) throw new WebhookDeliveryError('http_4xx');
    if (status >= 500 && status <= 599) throw new WebhookDeliveryError('http_5xx');
    throw new WebhookDeliveryError('connect_failed');
  }

  /** Step 2-3: one POST over the protocol's native module; the answer body is drained and dropped. */
  private send(target: URL, headers: Record<string, string>, body: string): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const transport = target.protocol === 'https:' ? https : http;
      const request = transport.request(
        target,
        {
          method: 'POST',
          headers,
          lookup: this.urlGuard.createLookup(),
          signal: AbortSignal.timeout(this.config.deliveryTimeoutMs),
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );

      request.on('error', reject);
      request.end(body);
    });
  }

  /** Step 5: operators keep the raw cause and the host; the caller keeps only the code. */
  private logRawFailure(error: unknown, host: string): void {
    const errno = error as NodeJS.ErrnoException;
    const code = errno?.code ?? errno?.name ?? 'unknown';
    const message = error instanceof Error ? error.message : String(error);
    this.logger.warn(`Outbound webhook delivery to ${host} failed (${code}): ${message}`);
  }
}
