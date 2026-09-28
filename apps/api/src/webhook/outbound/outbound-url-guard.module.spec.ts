import { Test, TestingModule } from '@nestjs/testing';
import { WEBHOOK_CFG } from '../../config/webhook.config';
import { GlobalStubsModule, mockWebhookConfig } from '../../common/test-helpers/global-stubs.module';
import { WebhookModule } from '../webhook.module';
import { DnsResolver } from './dns-resolver';
import { OutboundUrlGuard } from './outbound-url-guard';

describe('US-002: WebhookModule outbound guard wiring', () => {
  let moduleRef: TestingModule;

  afterEach(async () => {
    if (moduleRef) {
      await moduleRef.close();
      moduleRef = undefined as unknown as TestingModule;
    }
  });

  it('US-002: WebhookModule provides DnsResolver and OutboundUrlGuard with the webhook config', async () => {
    moduleRef = await Test.createTestingModule({
      imports: [GlobalStubsModule, WebhookModule],
    }).compile();

    expect(moduleRef.get(DnsResolver)).toBeInstanceOf(DnsResolver);
    const guard = moduleRef.get(OutboundUrlGuard);
    expect(guard).toBeInstanceOf(OutboundUrlGuard);
    expect(moduleRef.get(WEBHOOK_CFG)).toBe(mockWebhookConfig);
  });
});
