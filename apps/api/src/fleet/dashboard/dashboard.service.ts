import { Inject, Injectable } from '@nestjs/common';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { BudgetGate } from '../budgets/budget-gate';
import { QUEUED_SCAN_LIMIT, toLoads } from '../jobs/placement-rules';
import { buildAttention } from './attention-rules';
import { buildDashboardView, DashboardView, readCapabilities } from './dashboard-view';
import { AttentionThresholds, DASHBOARD_LIMITS, DashboardRunnerRow, DashboardScope } from './dashboard.types';
import { DASHBOARD_REPOSITORY, IDashboardRepository } from './domain/dashboard.domain';

type DashboardConfig = Pick<IFleetConfig, 'runnerOfflineSec' | 'jobSilentSec' | 'jobSilentErrorSec' | 'jobStartSec' | 'jobQueuedWarnSec' | 'credentialExpiryWarnDays'>;

/** S2b (c) spec §1: one snapshot per request; reads in parallel, no transaction (D411). */
@Injectable()
export class FleetDashboardService {
  constructor(
    @Inject(DASHBOARD_REPOSITORY) private readonly repo: IDashboardRepository,
    private readonly budgets: BudgetGate,
    @Inject(FLEET_CFG) private readonly cfg: DashboardConfig,
  ) {}

  async snapshot(scope: DashboardScope, now: Date): Promise<DashboardView> {
    const [rawRunners, held, active, queued, recent, counts, pauses] = await Promise.all([
      this.repo.findRunners(),
      this.repo.findHeldRefs(),
      this.repo.findActiveJobs(scope, DASHBOARD_LIMITS.activeJobs + 1),
      this.repo.findQueuedWindow(QUEUED_SCAN_LIMIT),
      this.repo.findRecentJobs(scope, new Date(now.getTime() - DASHBOARD_LIMITS.recentWindowMs), DASHBOARD_LIMITS.recentJobs + 1),
      this.repo.countActiveByState(scope),
      this.budgets.snapshot(now),
    ]);
    const listed = active.slice(0, DASHBOARD_LIMITS.activeJobs);
    const pending = new Map((await this.repo.pendingSummaryByJob(listed.map((j) => j.id))).map((p) => [p.jobId, p] as const));
    const runners: DashboardRunnerRow[] = rawRunners.map((r) => ({ ...r, capabilities: readCapabilities(r.capabilities) }));
    const loads = toLoads(held);
    const heldByRunner = new Map([...loads].map(([id, load]) => [id, load.active] as const));
    const thresholds: AttentionThresholds = {
      runnerOfflineSec: this.cfg.runnerOfflineSec, jobSilentSec: this.cfg.jobSilentSec, jobSilentErrorSec: this.cfg.jobSilentErrorSec,
      jobStartSec: this.cfg.jobStartSec, jobQueuedWarnSec: this.cfg.jobQueuedWarnSec, credentialExpiryWarnDays: this.cfg.credentialExpiryWarnDays,
    };
    const attention = buildAttention({ scope, runners, heldByRunner, activeJobs: listed, pending, dryRun: { queued, loads, pauses } }, now, thresholds);
    return buildDashboardView({ scope, now, offlineSec: this.cfg.runnerOfflineSec, runners, heldByRunner, active, recent, counts, pending, attention });
  }
}
