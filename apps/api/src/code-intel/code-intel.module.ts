import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ConfigModule } from '@nestjs/config';
import { CodeIntelController } from './code-intel.controller';
import { AstIndexService } from './ast-index.service';
import { SymbolStore } from './symbol-store';
import { CodeGraphService } from './code-graph.service';
import { CodeCommitOutboxHandler } from './code-commit-outbox-handler';

@Module({
  imports: [PrismaModule, ConfigModule],
  controllers: [CodeIntelController],
  providers: [AstIndexService, SymbolStore, CodeGraphService, CodeCommitOutboxHandler],
  exports: [AstIndexService, SymbolStore, CodeGraphService, CodeCommitOutboxHandler],
})
export class CodeIntelModule {}
