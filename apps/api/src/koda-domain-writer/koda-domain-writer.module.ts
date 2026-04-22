import { Module } from '@nestjs/common';
import { KodaDomainWriter } from './koda-domain-writer.service';
import { RagModule } from '../rag/rag.module';

@Module({
  imports: [RagModule],
  providers: [KodaDomainWriter],
  exports: [KodaDomainWriter],
})
export class KodaDomainWriterModule {}
