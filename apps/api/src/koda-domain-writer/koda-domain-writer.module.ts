import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { KodaDomainWriter } from './koda-domain-writer.service';
import { PrismaKodaDomainWriterRepository } from './prisma-koda-domain-writer.repository';
import { KODA_DOMAIN_WRITER_REPOSITORY } from './domain/koda-domain-writer.domain';
import { RagModule } from '../rag/rag.module';
import { OutboxModule } from '../outbox/outbox.module';
import { EventsModule } from '../events/events.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [PrismaModule, RagModule, OutboxModule, EventsModule, AuthModule],
  providers: [
    PrismaKodaDomainWriterRepository,
    { provide: KODA_DOMAIN_WRITER_REPOSITORY, useExisting: PrismaKodaDomainWriterRepository },
    KodaDomainWriter,
  ],
  exports: [KodaDomainWriter],
})
export class KodaDomainWriterModule {}
