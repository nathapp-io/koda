import { ConfigService } from '@nestjs/config';
import { NathApplication } from '@nathapp/nestjs-app';
import { canRunDbTests } from '../../helpers/test-environment';
import { bootHttpApp } from '../../helpers/http-app';
import { WEBHOOK_SIGNATURE_CFG, IWebhookSignatureConfig } from '../../../src/config/webhook-signature.config';

const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('webhook signature config (US-002)', () => {
  let app: NathApplication;

  beforeAll(async () => {
    const previous = {
      WEBHOOK_SIGNATURE_V1_ENABLED: process.env.WEBHOOK_SIGNATURE_V1_ENABLED,
      CI_WEBHOOK_REQUIRE_V2: process.env.CI_WEBHOOK_REQUIRE_V2,
    };
    delete process.env.WEBHOOK_SIGNATURE_V1_ENABLED;
    delete process.env.CI_WEBHOOK_REQUIRE_V2;
    try {
      app = await bootHttpApp({ registrationEnabled: false });
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  it('AC-8: registers the default config in the booted application', () => {
    const config = app.get(ConfigService).get<IWebhookSignatureConfig>(WEBHOOK_SIGNATURE_CFG);
    expect(config).toEqual({ v1Enabled: true, ciRequireV2: false });
  });
});
