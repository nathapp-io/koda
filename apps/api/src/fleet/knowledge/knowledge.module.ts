import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { RagModule } from '../../rag/rag.module';
import { ProjectAccessModule } from '../../projects/project-access.module';
import { GitBrokerModule } from '../git-broker/git-broker.module';
import { KNOWLEDGE_INDEX_REPOSITORY } from './knowledge-index.domain';
import { KnowledgeChunkStore } from './knowledge-chunk-store';
import { KnowledgeIndexService } from './knowledge-index.service';
import { KnowledgeSearchService } from './knowledge-search.service';
import { ProjectKnowledgeController } from './project-knowledge.controller';
import { PrismaKnowledgeIndexRepository } from './prisma-knowledge-index.repository';

/**
 * Fleet S5b knowledge index (1c-c-D2). Exports services only; the repository stays module-private.
 * Later stories add the indexer, queue and poller here.
 */
@Module({
  imports: [PrismaModule, RagModule, GitBrokerModule, ProjectAccessModule],
  controllers: [ProjectKnowledgeController],
  providers: [
    PrismaKnowledgeIndexRepository,
    { provide: KNOWLEDGE_INDEX_REPOSITORY, useExisting: PrismaKnowledgeIndexRepository },
    KnowledgeChunkStore,
    KnowledgeIndexService,
    KnowledgeSearchService,
  ],
  exports: [KnowledgeIndexService, KnowledgeSearchService],
})
export class KnowledgeModule {}
