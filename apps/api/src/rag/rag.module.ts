import { Module } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { RagController } from './rag.controller';
import { RagService } from './rag.service';
import { EmbeddingService } from './embedding.service';

@Module({
  controllers: [RagController],
  providers: [
    RagService,
    EmbeddingService,
    { provide: 'PrismaService', useExisting: PrismaService<PrismaClient> },
  ],
  exports: [RagService],
})
export class RagModule {}
