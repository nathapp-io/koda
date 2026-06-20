import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ConfigModule } from '@nestjs/config';
import { CodeIntelController } from './code-intel.controller';
import { AstIndexService } from './ast-index.service';
import { SymbolStore } from './symbol-store';
import { CodeGraphService } from './code-graph.service';
import { CodeCommitOutboxHandler } from './code-commit-outbox-handler';
import { ImpactAnalysisService } from './impact-analysis.service';
import { EntityGraphModule } from '../entity-graph/entity-graph.module';
import { RagModule } from '../rag/rag.module';
import { ProjectsModule } from '../projects/projects.module';
import { PrismaCodeIntelRepository } from './prisma-code-intel.repository';
import { CODE_INTEL_REPOSITORY } from './domain/code-intel.domain';

@Module({
  imports: [PrismaModule, ConfigModule, EntityGraphModule, forwardRef(() => RagModule), forwardRef(() => ProjectsModule)],
  controllers: [CodeIntelController],
  providers: [
    PrismaCodeIntelRepository,
    { provide: CODE_INTEL_REPOSITORY, useExisting: PrismaCodeIntelRepository },
    AstIndexService,
    SymbolStore,
    CodeGraphService,
    CodeCommitOutboxHandler,
    ImpactAnalysisService,
  ],
  exports: [AstIndexService, SymbolStore, CodeGraphService, CodeCommitOutboxHandler, ImpactAnalysisService],
})
export class CodeIntelModule {}
