import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { restoreEnvAfterEach } from '../common/test-helpers/restore-env';
import { GlobalStubsModule } from '../common/test-helpers/global-stubs.module';
import { RETENTION_CFG, retentionConfig } from './retention.config';

const RETENTION_ENV = [
  'WEBHOOK_DELIVERY_RETENTION_DAYS',
  'APPROVAL_RETENTION_DAYS',
  'AUDIT_RETENTION_DAYS',
] as const;

function clearRetentionEnv(): void {
  for (const key of RETENTION_ENV) delete process.env[key];
}

describe('retention config', () => {
  restoreEnvAfterEach();

  it('AC-1: defaults webhook delivery retention to 30 days outside test', () => {
    clearRetentionEnv();
    process.env.NODE_ENV = 'production';
    expect(retentionConfig().webhookDeliveryDays).toBe(30);
  });

  it('AC-2: defaults approval retention to 180 days outside test', () => {
    clearRetentionEnv();
    process.env.NODE_ENV = 'production';
    expect(retentionConfig().approvalDays).toBe(180);
  });

  it('AC-3: defaults audit retention to 365 days outside test', () => {
    clearRetentionEnv();
    process.env.NODE_ENV = 'production';
    expect(retentionConfig().auditDays).toBe(365);
  });

  it('AC-4: disables the unset audit retention default in test', () => {
    clearRetentionEnv();
    process.env.NODE_ENV = 'test';
    expect(retentionConfig().auditDays).toBeNull();
  });

  it('AC-5: an explicit zero disables audit retention', () => {
    clearRetentionEnv();
    process.env.NODE_ENV = 'production';
    process.env.AUDIT_RETENTION_DAYS = '0';
    expect(retentionConfig().auditDays).toBeNull();
  });

  it('AC-6: honors a positive approval retention override', () => {
    clearRetentionEnv();
    process.env.APPROVAL_RETENTION_DAYS = '7';
    expect(retentionConfig().approvalDays).toBe(7);
  });

  it('AC-8: GlobalStubsModule registers disabled retention config under test', async () => {
    clearRetentionEnv();
    process.env.NODE_ENV = 'test';
    let module: TestingModule | undefined;
    try {
      module = await Test.createTestingModule({ imports: [GlobalStubsModule] }).compile();
      expect(module.get(ConfigService).get<{ auditDays: number | null }>(RETENTION_CFG)).toMatchObject({ auditDays: null });
    } finally {
      await module?.close();
    }
  });
});
