import { Module } from '@nestjs/common';
import { KodaDomainWriter } from './koda-domain-writer.service';
import { RagModule } from '../rag/rag.module';
import { OutboxModule } from '../outbox/outbox.module';

@Module({
  imports: [RagModule, OutboxModule],
  providers: [KodaDomainWriter],
  exports: [KodaDomainWriter],
})
export class KodaDomainWriterModule {}
