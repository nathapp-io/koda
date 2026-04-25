import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { RagModule } from '../rag/rag.module';
import { MemoryModule } from '../memory/memory.module';

@Module({
  imports: [RagModule, MemoryModule],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
