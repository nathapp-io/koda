import { registerAs } from '@nestjs/config';

export const WEBHOOK_CFG = 'webhook';
export const DEFAULT_WEBHOOK_DELIVERY_TIMEOUT_MS = 5_000;

export interface IWebhookConfig {
  allowedHostnames: readonly string[];
  allowedCidrs: readonly string[];
  deliveryTimeoutMs: number;
}

/** STUB — splits, trims and classifies `WEBHOOK_ALLOWED_HOSTS` entries; throws on a bad entry. */
export function parseAllowedHosts(raw: string | undefined): Pick<IWebhookConfig, 'allowedHostnames' | 'allowedCidrs'> {
  throw new Error(`parseAllowedHosts not implemented (raw length ${raw?.length ?? 0})`);
}

/** STUB — real factory lands in the implementation session. */
export const webhookConfig = registerAs(WEBHOOK_CFG, (): IWebhookConfig => {
  throw new Error('webhookConfig not implemented');
});
