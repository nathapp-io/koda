import { Injectable, Module } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { GlobalStubsModule } from '../common/test-helpers/global-stubs.module';
import { ApprovalEngineModule } from '../approvals/approval-engine.module';
import { WebhookDispatchModule } from './webhook-dispatch.module';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { WebhookModule } from './webhook.module';
import { WebhookService } from './webhook.service';
import { PrismaWebhookRepository } from './prisma-webhook.repository';
import { WEBHOOK_REPOSITORY } from './domain/webhook.domain';

@Injectable()
class DispatchConsumer {
  constructor(readonly dispatcher: WebhookDispatcherService) {}
}
@Module({ imports: [WebhookDispatchModule], providers: [DispatchConsumer] })
class ConsumerModule {}

describe('WebhookDispatchModule', () => {
  let moduleRef: TestingModule;
  afterEach(async () => { await moduleRef?.close(); });

  it('AC-11: exports only the dispatcher, resolves with global stubs and keeps repositories private', async () => {
    moduleRef = await Test.createTestingModule({ imports: [GlobalStubsModule, ConsumerModule] }).compile();
    expect(moduleRef.get(DispatchConsumer).dispatcher).toBeInstanceOf(WebhookDispatcherService);
    expect(Reflect.getMetadata('imports', WebhookDispatchModule) ?? []).toEqual([]);
    expect(Reflect.getMetadata('exports', WebhookDispatchModule)).toEqual([WebhookDispatcherService]);
    expect(Reflect.getMetadata('exports', WebhookDispatchModule)).not.toContain(PrismaWebhookRepository);
    expect(Reflect.getMetadata('exports', WebhookDispatchModule)).not.toContain(WEBHOOK_REPOSITORY);
  });

  it('AC-11: WebhookModule and the engine share one dispatcher and retain WebhookService resolution', async () => {
    moduleRef = await Test.createTestingModule({ imports: [GlobalStubsModule, WebhookModule, ApprovalEngineModule, ConsumerModule] }).compile();
    expect(moduleRef.get(WebhookService)).toBeInstanceOf(WebhookService);
    const dispatcher = moduleRef.get(DispatchConsumer).dispatcher;
    expect(moduleRef.get(WebhookDispatcherService)).toBe(dispatcher);
    expect(Reflect.getMetadata('providers', WebhookModule)).not.toContain(WebhookDispatcherService);
    expect(Reflect.getMetadata('imports', ApprovalEngineModule)).toContain(WebhookDispatchModule);
  });
});
