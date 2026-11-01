import { Inject, Injectable } from '@nestjs/common';
import type { ReviewDecision } from '@nathapp/fleet-protocol';
import { PrismaMemoryItemRepository } from './prisma-memory-item.repository';
import { buildReviewDecisions, MAX_REVIEW_DECISIONS } from './review-decisions';

@Injectable()
export class ReviewDecisionsService {
  constructor(
    @Inject(PrismaMemoryItemRepository) private readonly memoryItems: PrismaMemoryItemRepository,
  ) {}

  async selectForReview(projectId: string, repoId: string): Promise<ReviewDecision[]> {
    const rows = await this.memoryItems.findReviewDecisionRows(projectId, repoId, MAX_REVIEW_DECISIONS);
    return buildReviewDecisions(rows.recorded, rows.reviewMinted);
  }
}
