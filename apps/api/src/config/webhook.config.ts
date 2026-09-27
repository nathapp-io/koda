import * as net from 'net';
import { registerAs } from '@nestjs/config';

export const WEBHOOK_CFG = 'webhook';
export const DEFAULT_WEBHOOK_DELIVERY_TIMEOUT_MS = 5_000;

export interface IWebhookConfig {
  allowedHostnames: readonly string[]; // lower-cased, trailing dot stripped
  allowedCidrs: readonly string[];     // e.g. '10.0.0.0/24', 'fd00::/8'
  deliveryTimeoutMs: number;           // always DEFAULT_WEBHOOK_DELIVERY_TIMEOUT_MS
}

/** `^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$` */
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * Splits, trims and classifies `WEBHOOK_ALLOWED_HOSTS` entries. An entry containing
 * `/` is a CIDR (IPv4 prefix 0–32, IPv6 prefix 0–128); anything else is a hostname
 * (lower-cased, one trailing dot stripped, must match the host-name regex). A bad
 * entry throws an `Error` whose message names the entry — the boot-time Joi rule
 * turns that into a `ValidationAppException` field error.
 */
export function parseAllowedHosts(
  raw: string | undefined,
): Pick<IWebhookConfig, 'allowedHostnames' | 'allowedCidrs'> {
  const allowedHostnames: string[] = [];
  const allowedCidrs: string[] = [];

  if (raw === undefined) {
    return { allowedHostnames, allowedCidrs };
  }

  for (const rawEntry of raw.split(',')) {
    const entry = rawEntry.trim();
    if (entry === '') continue;

    if (entry.includes('/')) {
      const slash = entry.indexOf('/');
      const addressPart = entry.slice(0, slash);
      const prefixPart = entry.slice(slash + 1);
      // `prefixPart` must be a bare decimal integer with no leading sign or padding.
      if (!/^\d+$/.test(prefixPart)) {
        throw new Error(`Invalid CIDR "${entry}": prefix must be a non-negative integer`);
      }
      const prefix = Number(prefixPart);
      const ipVersion = net.isIP(addressPart);
      if (ipVersion === 0) {
        throw new Error(`Invalid CIDR "${entry}": address is not a valid IPv4 or IPv6 literal`);
      }
      if (ipVersion === 4 && prefix > 32) {
        throw new Error(`Invalid CIDR "${entry}": IPv4 prefix must be 0–32`);
      }
      if (ipVersion === 6 && prefix > 128) {
        throw new Error(`Invalid CIDR "${entry}": IPv6 prefix must be 0–128`);
      }
      allowedCidrs.push(entry);
      continue;
    }

    // Hostname: lower-case and strip exactly one trailing dot.
    const lower = entry.toLowerCase();
    const normalised = lower.endsWith('.') ? lower.slice(0, -1) : lower;
    if (!HOSTNAME_RE.test(normalised)) {
      throw new Error(`Invalid hostname "${entry}"`);
    }
    allowedHostnames.push(normalised);
  }

  return { allowedHostnames, allowedCidrs };
}

export const webhookConfig = registerAs(WEBHOOK_CFG, (): IWebhookConfig => {
  const { allowedHostnames, allowedCidrs } = parseAllowedHosts(process.env['WEBHOOK_ALLOWED_HOSTS']);
  return {
    allowedHostnames,
    allowedCidrs,
    deliveryTimeoutMs: DEFAULT_WEBHOOK_DELIVERY_TIMEOUT_MS,
  };
});
