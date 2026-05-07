import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { RagModule } from '../rag/rag.module';
import { MemoryModule } from '../memory/memory.module';
import { CodeIntelModule } from '../code-intel/code-intel.module';

@Module({
  imports: [RagModule, MemoryModule, CodeIntelModule],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
