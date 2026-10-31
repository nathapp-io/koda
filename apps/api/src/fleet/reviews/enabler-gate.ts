import { Inject, Injectable } from '@nestjs/common';
import type { PrincipalRef } from '../../permissions/permissions.types';
import { PermissionService } from '../../permissions/permission.service';
import type { FleetRepoRecord } from '../repos/domain/fleet-repo.domain';
import { FleetReposService } from '../repos/fleet-repos.service';
import { FLEET_PR_REVIEW_REPOSITORY, type IFleetPrReviewRepository } from './domain/fleet-pr-review.domain';
import { mayDispatch } from '../schedules/schedule-access';

/** Revalidates the principal that enabled auto-review before a pass reads or dispatches PRs. */
@Injectable()
export class EnablerGate {
  constructor(
    @Inject(FLEET_PR_REVIEW_REPOSITORY) private readonly reviews: IFleetPrReviewRepository,
    private readonly permissions: PermissionService,
    private readonly repos: FleetReposService,
  ) {}

  async check(repo: FleetRepoRecord): Promise<PrincipalRef | null> {
    const { autoReviewEnabledById: id, autoReviewEnabledByType: type } = repo;
    if (id === null || type === null) return null;

    const enabler: PrincipalRef = { type, id };
    const [access, keys] = await Promise.all([
      this.reviews.findPrincipalAccess(enabler),
      this.permissions.effectiveKeys(enabler, { projectId: repo.projectId }),
    ]);
    if (mayDispatch(access, keys)) return enabler;

    await this.repos.disableAutoReview(repo.id, 'enabler_lost_access', enabler.id);
    return null;
  }
}
