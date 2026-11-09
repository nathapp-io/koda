import { Inject, Injectable } from '@nestjs/common';
import { FleetReposService } from '../repos/fleet-repos.service';
import { TicketsService } from '../../tickets/tickets.service';
import { FLEET_FLOW_STEP_REPOSITORY, type IFleetFlowStepRepository } from './domain/fleet-flow-step.domain';
import { FleetFlowJobDto, FleetFlowOverviewDto, FleetFlowRepoDto } from './dto/fleet-flow-overview.dto';
import { FleetFlowsService } from './fleet-flows.service';
import { countUnknownCost, totalCostUsd } from './flow-overview';

/** The overview reads at most this many jobs; a flow with more reports `truncated` instead. */
const OVERVIEW_JOB_LIMIT = 500;

/**
 * The flow page's own read: the repo the flow runs against, the ref of the ticket the flow tracks, the
 * flow's jobs and how many of them have no known cost.
 *
 * The flow record fences the read: a flow of another project (or none) is `fleet.flows.notFound`, and
 * nothing is read behind it. The repo and the ticket come from the services that own them, so this
 * service never reaches into another module's rows.
 */
@Injectable()
export class FleetFlowOverviewService {
  constructor(
    private readonly flows: FleetFlowsService,
    private readonly repos: FleetReposService,
    private readonly tickets: TicketsService,
    @Inject(FLEET_FLOW_STEP_REPOSITORY) private readonly steps: IFleetFlowStepRepository,
  ) {}

  async overview(projectId: string, flowId: string): Promise<FleetFlowOverviewDto> {
    const flow = await this.flows.get(projectId, flowId);
    const [repo, ticketRef, jobPage] = await Promise.all([
      this.repos.findIdentity(flow.repoId),
      this.ticketRef(projectId, flow.ticketId ?? null),
      this.steps.listFlowJobs(flowId, OVERVIEW_JOB_LIMIT),
    ]);
    // A job names the flow feature it belongs to; the feature ids live in the flow itself, so the
    // name comes from the flow's own features and not from the job row.
    const featureNames = new Map(flow.features.map((feature) => [feature.id, feature.feature]));
    return Object.assign(new FleetFlowOverviewDto(), {
      repo: repo ? Object.assign(new FleetFlowRepoDto(), repo) : null,
      ticketRef,
      jobs: jobPage.jobs.map((row) => Object.assign(new FleetFlowJobDto(), {
        id: row.id,
        feature: row.flowFeatureId ? featureNames.get(row.flowFeatureId) ?? null : null,
        step: row.flowStep,
        command: row.command,
        state: row.state,
        costUsd: totalCostUsd(row),
        queuedAt: row.queuedAt.toISOString(),
        finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
      })),
      truncated: jobPage.truncated,
      unknownCostCount: countUnknownCost(jobPage.jobs),
    });
  }

  /** The ref of the flow's ticket, or null when the flow has no ticket or its ticket is gone. */
  private async ticketRef(projectId: string, ticketId: string | null): Promise<string | null> {
    if (!ticketId) return null;
    const refs = await this.tickets.findRefsByIds(projectId, [ticketId]);
    return refs.get(ticketId) ?? null;
  }
}
