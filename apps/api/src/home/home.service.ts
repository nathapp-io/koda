import { Inject, Injectable } from '@nestjs/common';
import { ATTENTION_WINDOW_MS, HOME_LIMITS, buildHomeView, type HomeCaller, type HomeView } from './home.types';
import { HOME_REPOSITORY, type IHomeRepository } from './home.domain';

/**
 * UX redesign slice 2: one request for the web dashboard. Reads run in two waves —
 * blocked jobs need the pending approvals' job ids — then a pure builder assembles the view.
 */
@Injectable()
export class HomeService {
  constructor(@Inject(HOME_REPOSITORY) private readonly repo: IHomeRepository) {}

  async snapshot(caller: HomeCaller, now: Date): Promise<HomeView> {
    const projects = await this.repo.findProjects(caller);
    const projectIds = projects.map((p) => p.id);
    const since = new Date(now.getTime() - ATTENTION_WINDOW_MS);
    const scope = { projectIds, includeUnscoped: caller.globalAdmin };

    const [tickets, ticketsTotal, approvals, approvalsTotal, failedJobs, failedJobsTotal, openTicketsByProject, activity] =
      await Promise.all([
        this.repo.findMyTickets(caller.id, projectIds, HOME_LIMITS.tickets),
        this.repo.countMyTickets(caller.id, projectIds),
        this.repo.findPendingApprovals(scope, HOME_LIMITS.pendingScan),
        this.repo.countPendingApprovals(scope),
        this.repo.findFailedJobs(projectIds, since, HOME_LIMITS.jobs),
        this.repo.countFailedJobs(projectIds, since),
        this.repo.countOpenTicketsByProject(projectIds),
        this.repo.findRecentActivity(projectIds, HOME_LIMITS.activityScan),
      ]);

    const blockedJobIds = [...new Set(approvals.map((a) => a.jobId).filter((id): id is string => id !== null))];
    const [blockedJobs, blockedJobsTotal, attentionJobsByProject] = await Promise.all([
      this.repo.findBlockedJobs(blockedJobIds, HOME_LIMITS.jobs),
      this.repo.countBlockedJobs(blockedJobIds),
      this.repo.countAttentionJobsByProject(projectIds, since, blockedJobIds),
    ]);

    return buildHomeView({
      now,
      projects,
      tickets,
      ticketsTotal,
      approvals,
      approvalsTotal,
      failedJobs,
      failedJobsTotal,
      blockedJobs,
      blockedJobsTotal,
      openTicketsByProject,
      attentionJobsByProject,
      activity,
    });
  }
}
