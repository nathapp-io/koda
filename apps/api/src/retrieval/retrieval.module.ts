import { Module } from '@nestjs/common';
import { EvaluationService } from './evaluation.service';
import { RetrievalController } from './retrieval.controller';
import { RagModule } from '../rag/rag.module';
import { ProjectAccessModule } from '../projects/project-access.module';

@Module({
  imports: [RagModule, ProjectAccessModule],
  controllers: [RetrievalController],
  providers: [EvaluationService],
  exports: [EvaluationService],
})
export class RetrievalModule {}
