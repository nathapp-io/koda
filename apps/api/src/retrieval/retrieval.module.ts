import { Module } from '@nestjs/common';
import { EvaluationService } from './evaluation.service';
import { RagModule } from '../rag/rag.module';

@Module({
  imports: [RagModule],
  providers: [EvaluationService],
  exports: [EvaluationService],
})
export class RetrievalModule {}
