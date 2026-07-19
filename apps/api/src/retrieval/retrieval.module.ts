import { Module } from '@nestjs/common';
import { EvaluationService } from './evaluation.service';
import { RetrievalController } from './retrieval.controller';
import { RagModule } from '../rag/rag.module';

@Module({
  imports: [RagModule],
  controllers: [RetrievalController],
  providers: [EvaluationService],
  exports: [EvaluationService],
})
export class RetrievalModule {}
