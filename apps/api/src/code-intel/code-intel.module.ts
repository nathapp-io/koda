import { Module } from '@nestjs/common';
import { CodeIntelController } from './code-intel.controller';
import { AstIndexService } from './ast-index.service';
import { SymbolStore } from './symbol-store';
import { CodeGraphService } from './code-graph.service';

@Module({
  controllers: [CodeIntelController],
  providers: [AstIndexService, SymbolStore, CodeGraphService],
  exports: [AstIndexService, SymbolStore, CodeGraphService],
})
export class CodeIntelModule {}
