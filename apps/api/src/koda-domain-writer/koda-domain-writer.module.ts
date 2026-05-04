import { Module } from '@nestjs/common';
import { KodaDomainWriter } from './koda-domain-writer.service';
import { RagModule } from '../rag/rag.module';
import { OutboxModule } from '../outbox/outbox.module';
import { EventsModule } from '../events/events.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [RagModule, OutboxModule, EventsModule, AuthModule],
  providers: [KodaDomainWriter],
  exports: [KodaDomainWriter],
})
export class KodaDomainWriterModule {}
