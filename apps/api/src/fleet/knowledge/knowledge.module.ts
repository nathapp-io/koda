import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { RagModule } from '../../rag/rag.module';
import { ProjectAccessModule } from '../../projects/project-access.module';
import { GitBrokerModule } from '../git-broker/git-broker.module';
import { KNOWLEDGE_INDEX_REPOSITORY } from './knowledge-index.domain';
import { KnowledgeChunkStore } from './knowledge-chunk-store';
import { KnowledgeIndexQueue } from './knowledge-index.queue';
import { KnowledgeIndexService } from './knowledge-index.service';
import { KnowledgePoller } from './knowledge-poller';
import { KnowledgeSearchService } from './knowledge-search.service';
import { KnowledgeRepoIndexer, KNOWLEDGE_INDEX_CLOCK } from './knowledge-repo-indexer';
import { ProjectKnowledgeController } from './project-knowledge.controller';
import { PrismaKnowledgeIndexRepository } from './prisma-knowledge-index.repository';

/**
 * Fleet S5b knowledge index (1c-c-D2). Exports the two services plus the queue the merge hook triggers
 * (1c-c-D11); the repository, the indexer and the poller stay module-private.
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
    KnowledgeRepoIndexer,
    KnowledgeIndexQueue,
    KnowledgePoller,
    { provide: KNOWLEDGE_INDEX_CLOCK, useValue: Date.now },
  ],
  exports: [KnowledgeIndexService, KnowledgeSearchService, KnowledgeIndexQueue],
})
export class KnowledgeModule {}
