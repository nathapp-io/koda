import { validateUtil } from '@nathapp/nestjs-common';
import { registerAs } from '@nestjs/config';
import { IsOptional, Matches } from 'class-validator';

export const RETENTION_CFG = 'retention';

export interface IRetentionConfig {
  webhookDeliveryDays: number | null;
  approvalDays: number | null;
  auditDays: number | null;
}

class RetentionConfigSchema {
  @IsOptional()
  @Matches(/^\d+$/)
  WEBHOOK_DELIVERY_RETENTION_DAYS?: string;

  @IsOptional()
  @Matches(/^\d+$/)
  APPROVAL_RETENTION_DAYS?: string;

  @IsOptional()
  @Matches(/^\d+$/)
  AUDIT_RETENTION_DAYS?: string;
}

function retentionDays(envKey: string, defaultDays: number): number | null {
  const configured = process.env[envKey];
  if (configured !== undefined) {
    const days = Number.parseInt(configured, 10);
    return days > 0 ? days : null;
  }
  return process.env.NODE_ENV !== 'test' ? defaultDays : null;
}

export const retentionConfig = registerAs(RETENTION_CFG, (): IRetentionConfig => {
  validateUtil(process.env, RetentionConfigSchema);
  return {
    webhookDeliveryDays: retentionDays('WEBHOOK_DELIVERY_RETENTION_DAYS', 30),
    approvalDays: retentionDays('APPROVAL_RETENTION_DAYS', 180),
    auditDays: retentionDays('AUDIT_RETENTION_DAYS', 365),
  };
});
