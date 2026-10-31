import { Injectable } from '@nestjs/common';
import { SystemWriter } from '../../permissions/system-writer.decorator';

/** Declarer only: event orchestration and lifecycle arrive in subsequent stories. */
@Injectable()
@SystemWriter('system.review.decision')
export class ReviewEventMinter {
  async run(): Promise<void> {}
}
