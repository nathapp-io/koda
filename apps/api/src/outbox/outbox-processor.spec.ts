import { Test, TestingModule } from '@nestjs/testing';
import { createMock } from '@golevelup/ts-jest';
import { OutboxProcessor } from './outbox-processor';
import { OutboxService } from './outbox.service';

describe('OutboxProcessor', () => {
  let processor: OutboxProcessor;
  let outboxService: OutboxService;

  beforeEach(async () => {
    outboxService = createMock<OutboxService>({
      processPending: jest.fn().mockResolvedValue(undefined),
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OutboxProcessor,
        { provide: OutboxService, useValue: outboxService },
      ],
    }).compile();

    processor = module.get(OutboxProcessor);
  });

  it('is defined', () => {
    expect(processor).toBeDefined();
  });

  it('calls processPending on cron tick', async () => {
    await processor.processOutboxQueue();
    expect(outboxService.processPending).toHaveBeenCalledTimes(1);
  });

  it('delegates to outboxService without additional logic', async () => {
    await processor.processOutboxQueue();
    await processor.processOutboxQueue();
    expect(outboxService.processPending).toHaveBeenCalledTimes(2);
  });
});
