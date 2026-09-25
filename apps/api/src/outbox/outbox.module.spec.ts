import { Test, TestingModule } from '@nestjs/testing';
import { FanOutPublisher } from './fan-out-publisher';
import { PrismaOutboxRepository } from './prisma-outbox.repository';
import { noopLastErrors } from '../../test/helpers/outbox-record';

describe('FanOutPublisher (DI wiring)', () => {
  let moduleRef: TestingModule;

  afterEach(async () => {
    await moduleRef?.close();
  });

  it('resolves with only its repository dependency supplied', async () => {
    moduleRef = await Test.createTestingModule({
      providers: [FanOutPublisher, { provide: PrismaOutboxRepository, useValue: noopLastErrors }],
    }).compile();

    expect(moduleRef.get(FanOutPublisher)).toBeInstanceOf(FanOutPublisher);
  });
});
