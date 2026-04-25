import { Module, forwardRef } from '@nestjs/common';
import { EvaluationService } from './evaluation.service';
import { RagModule } from '../rag/rag.module';

@Module({
  imports: [forwardRef(() => RagModule)],
  providers: [EvaluationService],
  exports: [EvaluationService],
})
export class RetrievalModule {}
