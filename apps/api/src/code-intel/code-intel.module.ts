import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { CodeIntelController } from './code-intel.controller';
import { AstIndexService } from './ast-index.service';
import { SymbolStore } from './symbol-store';
import { CodeGraphService } from './code-graph.service';

@Module({
  imports: [PrismaModule],
  controllers: [CodeIntelController],
  providers: [AstIndexService, SymbolStore, CodeGraphService],
  exports: [AstIndexService, SymbolStore, CodeGraphService],
})
export class CodeIntelModule {}
