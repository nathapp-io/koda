import { Module } from '@nestjs/common';
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

@Module({
  imports: [PrismaModule, ConfigModule, EntityGraphModule, RagModule],
  controllers: [CodeIntelController],
  providers: [AstIndexService, SymbolStore, CodeGraphService, CodeCommitOutboxHandler, ImpactAnalysisService],
  exports: [AstIndexService, SymbolStore, CodeGraphService, CodeCommitOutboxHandler, ImpactAnalysisService],
})
export class CodeIntelModule {}
