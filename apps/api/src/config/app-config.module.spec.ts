/**
 * US-002 AC-8 without a database: the registered `WEBHOOK_SIGNATURE_CFG` namespace.
 *
 * `AppConfigModule` is the exact `ConfigModule` registration `AppModule` imports, so dropping
 * `webhookSignatureConfig` from the load array — or the whole registration from `AppModule` — fails
 * here, in the DB-free unit suite (`.nax/rules/api-testing.md`: module wiring is a unit test). The
 * full boot check stays in `test/integration/config/webhook-signature-config.integration.spec.ts`.
 *
 * Only the config namespaces are compiled, so no unrelated infrastructure (Prisma, HTTP) is needed;
 * every factory in the list reads `process.env`, which `test-setup.ts` fills from `.env.test`.
 */
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { AppConfigModule } from './app-config.module';
import { IWebhookSignatureConfig, WEBHOOK_SIGNATURE_CFG } from './webhook-signature.config';

const SWITCHES = ['WEBHOOK_SIGNATURE_V1_ENABLED', 'CI_WEBHOOK_REQUIRE_V2'] as const;

describe('app config registration (US-002 AC-8)', () => {
  let moduleRef: TestingModule | undefined;
  const previous = SWITCHES.map((key) => [key, process.env[key]] as const);

  beforeEach(() => {
    // The defaults are the assertion: neither switch is set for this boot.
    for (const key of SWITCHES) delete process.env[key];
  });

  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = undefined;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('AC-8: resolves the signature switches with their documented defaults', async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppConfigModule] }).compile();

    const config = moduleRef.get(ConfigService).get<IWebhookSignatureConfig>(WEBHOOK_SIGNATURE_CFG);

    expect(config).toEqual({ v1Enabled: true, ciRequireV2: false });
  });
});
