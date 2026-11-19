import { validateUtil } from '@nathapp/nestjs-common';
import { registerAs } from '@nestjs/config';
import { IsOptional, Matches } from 'class-validator';

export const WEBHOOK_SIGNATURE_CFG = 'webhookSignature';

export interface IWebhookSignatureConfig {
  v1Enabled: boolean;
  ciRequireV2: boolean;
}

class WebhookSignatureConfigSchema {
  @IsOptional()
  @Matches(/^(true|false)$/i)
  WEBHOOK_SIGNATURE_V1_ENABLED?: string;

  @IsOptional()
  @Matches(/^(true|false)$/i)
  CI_WEBHOOK_REQUIRE_V2?: string;
}

export const webhookSignatureConfig = registerAs(WEBHOOK_SIGNATURE_CFG, (): IWebhookSignatureConfig => {
  validateUtil(process.env, WebhookSignatureConfigSchema);
  const v1Enabled = process.env['WEBHOOK_SIGNATURE_V1_ENABLED'];
  const ciRequireV2 = process.env['CI_WEBHOOK_REQUIRE_V2'];
  return {
    v1Enabled: v1Enabled === undefined ? true : v1Enabled.toLowerCase() === 'true',
    ciRequireV2: ciRequireV2 !== undefined && ciRequireV2.toLowerCase() === 'true',
  };
});
