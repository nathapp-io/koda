import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InternalAppException } from '@nathapp/nestjs-common';
import { OutboxModule as NathappOutboxModule, OutboxModuleOptions } from '@nathapp/nestjs-outbox';
import { IOutboxConfig, OUTBOX_CFG } from '../config/outbox.config';
import { FanOutPublisher } from './fan-out-publisher';
import { OutboxCoreModule } from './outbox-core.module';
import { OutboxRetentionProcessor } from './outbox-retention.processor';
import { PrismaOutboxStore } from './prisma-outbox.store';

// Consumers (memory, entity-graph, code-intel, webhook, rag) import this module
// and register their handlers on FanOutPublisher in onModuleInit. It does not
// import them back (that would recreate the ESM temporal-dead-zone cycle).
// The package module is global: its OutboxService (record) and OutboxRelay are
// injectable everywhere.
@Module({
  imports: [
    OutboxCoreModule,
    NathappOutboxModule.registerAsync({
      imports: [OutboxCoreModule],
      inject: [PrismaOutboxStore, FanOutPublisher, ConfigService],
      useFactory: (store: PrismaOutboxStore, publisher: FanOutPublisher, config: ConfigService): OutboxModuleOptions => {
        const outbox = config.get<IOutboxConfig>(OUTBOX_CFG);
        if (!outbox) {
          throw new InternalAppException({
            config: 'outbox config not loaded — ensure outboxConfig is in ConfigModule.forRoot load array',
          });
        }
        return { store, publisher, relay: outbox.relay };
      },
    }),
  ],
  providers: [OutboxRetentionProcessor],
  exports: [OutboxCoreModule],
})
export class OutboxModule {}
