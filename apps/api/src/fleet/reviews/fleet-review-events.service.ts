import { Inject, Injectable } from '@nestjs/common';
import type { FleetJobRecord } from '../jobs/domain/fleet-job.domain';
import { prNumberOfReviewFeature } from '../common/review-jobs';
import type { BotReviewParse } from '../ingest/parsers/bot-review.parser';
import { FLEET_REVIEW_EVENT_REPOSITORY, type IFleetReviewEventRepository } from './domain/fleet-review-event.domain';

@Injectable()
export class FleetReviewEventsService {
  constructor(@Inject(FLEET_REVIEW_EVENT_REPOSITORY) private readonly repo: IFleetReviewEventRepository) {}

  /** Called under the ingest's job lock and transaction; duplicates never alter existing rows. */
  async recordForJob(
    job: Pick<FleetJobRecord, 'id' | 'projectId' | 'repoId' | 'feature'>,
    leaseEpoch: number,
    parse: BotReviewParse,
  ): Promise<{ pending: number }> {
    const prNumber = prNumberOfReviewFeature(job.feature);
    if (parse.outcome !== 'done' || prNumber === null) return { pending: 0 };
    const count = await this.repo.insertMany(parse.events.map(event => ({
      jobId: job.id, leaseEpoch, projectId: job.projectId, repoId: job.repoId, prNumber,
      findingKey: event.key, threadId: event.threadId, file: event.file ?? null, line: event.line ?? null,
      finding: event.finding, reason: event.reason, disagreedBy: event.disagreedBy, trusted: parse.trusted,
      status: parse.trusted ? 'pending' : 'skipped', skipReason: parse.trusted ? null : 'untrusted-pr',
    })));
    return { pending: parse.trusted ? count : 0 };
  }

  claimPending(limit: number) { return this.repo.claimPending(limit); }
  markMinted(id: string, result: { memoryItemId: string; approverLogin: string }) { return this.repo.markMinted(id, result); }
  markSkipped(id: string, reason: string) { return this.repo.markSkipped(id, reason); }
  bumpAttempt(id: string): Promise<number> { return this.repo.bumpAttempt(id); }
}
