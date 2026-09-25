import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import {
  InMemoryOutboxStore,
  OUTBOX_MODULE_OPTIONS,
  OUTBOX_PUBLISHER,
  OUTBOX_STORE,
  OutboxModuleOptions,
  OutboxRelay,
  OutboxService as NathappOutboxService,
} from '@nathapp/nestjs-outbox';
import { outboxConfig } from '../config/outbox.config';
import { FanOutPublisher } from './fan-out-publisher';
import { OutboxModule } from './outbox.module';
import { PrismaOutboxStore } from './prisma-outbox.store';

@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: { client: {} } },
    {
      provide: TRANSACTION_MANAGER,
      useValue: { run: <T>(fn: () => Promise<T>) => fn(), getClient: () => ({}), isInTransaction: () => false },
    },
  ],
  exports: [PrismaService, TRANSACTION_MANAGER],
})
class FakePrismaModule {}

describe('OutboxModule (DI wiring, no database)', () => {
  const saved = process.env['OUTBOX_RELAY_ENABLED'];
  let moduleRef: TestingModule;

  const compile = async (): Promise<TestingModule> =>
    Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [outboxConfig] }), FakePrismaModule, OutboxModule],
    }).compile();

  afterEach(async () => {
    await moduleRef?.close();
    if (saved === undefined) delete process.env['OUTBOX_RELAY_ENABLED'];
    else process.env['OUTBOX_RELAY_ENABLED'] = saved;
  });

  it('resolves PrismaOutboxStore as the store, never the in-memory fallback', async () => {
    moduleRef = await compile();
    const store = moduleRef.get(OUTBOX_STORE);
    expect(store).toBeInstanceOf(PrismaOutboxStore);
    expect(store).not.toBeInstanceOf(InMemoryOutboxStore);
  });

  it('uses the shared FanOutPublisher instance as the relay publisher', async () => {
    moduleRef = await compile();
    expect(moduleRef.get(OUTBOX_PUBLISHER)).toBe(moduleRef.get(FanOutPublisher));
  });

  it('passes the configured relay options, enabled outside tests', async () => {
    process.env['OUTBOX_RELAY_ENABLED'] = 'true';
    moduleRef = await compile();
    const options = moduleRef.get<OutboxModuleOptions>(OUTBOX_MODULE_OPTIONS);
    expect(options.relay).toEqual(outboxConfig().relay);
    expect(options.relay?.enabled).toBe(true);
  });

  it('exposes the package OutboxService and OutboxRelay', async () => {
    moduleRef = await compile();
    expect(moduleRef.get(NathappOutboxService)).toBeDefined();
    expect(moduleRef.get(OutboxRelay)).toBeDefined();
  });
});
