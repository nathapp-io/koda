import { Injectable } from '@nestjs/common';
import { currentContext } from '../action-context/action-context';
import { AuditRecorder } from '../audit/audit-recorder.service';
import { PrismaMemoryItemRepository } from './prisma-memory-item.repository';

export interface ReviewDecisionInput {
  projectId: string;
  repoId: string;
  prNumber: number;
  jobId: string;
  threadId: string;
  findingKey: string;
  finding: string;
  reason: string;
  file?: string;
  line?: number;
}

type Skipped = { status: 'skipped'; reason: 'duplicate' | 'retired' };
export type ReviewDecisionResult = { status: 'minted'; memoryItemId: string } | Skipped;

export function reviewDecisionObject(input: Pick<ReviewDecisionInput, 'finding' | 'reason' | 'file' | 'line'>): string {
  const location = input.file ? ` (${input.file}${input.line === undefined ? '' : `:${input.line}`})` : '';
  return `Not a defect: ${input.finding}. Reason: ${input.reason}${location}`;
}

/** Internal control flow: abort the transaction without changing memory or writing an audit. */
class ReviewDecisionSkipped extends Error {
  constructor(readonly result: Skipped) { super(result.reason); }
}

@Injectable()
export class ReviewDecisionWriter {
  constructor(private readonly repo: PrismaMemoryItemRepository, private readonly audit: AuditRecorder) {}

  async guard(input: ReviewDecisionInput): Promise<Skipped | null> {
    const reason = await this.repo.reviewDecisionGuard(input.projectId, `${input.jobId}:${input.threadId}`, `repo:${input.repoId}`, `review-finding:${input.findingKey}`);
    return reason === null ? null : { status: 'skipped', reason };
  }

  async mint(input: ReviewDecisionInput): Promise<ReviewDecisionResult> {
    try {
      const item = await this.repo.upsert({
        projectId: input.projectId,
        kind: 'DECISION',
        subject: `repo:${input.repoId}`,
        predicate: `review-finding:${input.findingKey}`,
        object: reviewDecisionObject(input),
        confidence: 1,
        ownerType: null,
        sourceType: 'review_event',
        sourceId: `${input.jobId}:${input.threadId}`,
      }, {
        beforeWrite: async () => {
          const skipped = await this.guard(input);
          if (skipped) throw new ReviewDecisionSkipped(skipped);
        },
        onWritten: async ({ item: written }) => {
          await this.audit.record({
            key: 'system.review.decision', resourceType: 'memory-item', resourceId: written.id,
            projectId: input.projectId,
            summary: `review decision from job ${input.jobId}, PR #${input.prNumber}, approver ${currentContext()?.approval.approverId} (one of the thread's commenters)`,
          });
        },
      });
      return { status: 'minted', memoryItemId: item.id };
    } catch (error) {
      if (error instanceof ReviewDecisionSkipped) return error.result;
      throw error;
    }
  }
}
