import { Inject, Injectable } from '@nestjs/common';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { BudgetGate } from '../budgets/budget-gate';
import { QUEUED_SCAN_LIMIT, toLoads } from '../jobs/placement-rules';
import { ProviderCredentialsService } from '../provider-credentials/provider-credentials.service';
import { providerScopeLookupKey, type ProviderLookupScope } from '../provider-credentials/provider-credential.domain';
import { buildAttention } from './attention-rules';
import { buildDashboardView, DashboardView, readCapabilities } from './dashboard-view';
import { AttentionThresholds, DASHBOARD_LIMITS, DashboardJobRow, DashboardRunnerRow, DashboardScope } from './dashboard.types';
import { DASHBOARD_REPOSITORY, IDashboardRepository } from './domain/dashboard.domain';

type DashboardConfig = Pick<IFleetConfig, 'runnerOfflineSec' | 'jobSilentSec' | 'jobSilentErrorSec' | 'jobStartSec' | 'jobQueuedWarnSec' | 'credentialExpiryWarnDays'>;

/** The answer for a scope the vault can serve nothing for; shared, never mutated. */
const NO_PROVIDERS: ReadonlySet<string> = new Set<string>();

/** S2b (c) spec §1: one snapshot per request; reads in parallel, no transaction (D411). */
@Injectable()
export class FleetDashboardService {
  constructor(
    @Inject(DASHBOARD_REPOSITORY) private readonly repo: IDashboardRepository,
    private readonly budgets: BudgetGate,
    @Inject(FLEET_CFG) private readonly cfg: DashboardConfig,
    /**
     * C10 (branch review B3): the dry-run judges provider needs exactly as placement does, so it asks the
     * vault's public service which providers it can serve for the queued window's scopes.
     */
    private readonly credentials: ProviderCredentialsService,
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
    // THREAD jobs consume thread capacity, not RUN capacity; keep the projections separate.
    const loads = toLoads(held);
    const heldByRunner = new Map<string, number>();
    for (const ref of held) heldByRunner.set(ref.runnerId, (heldByRunner.get(ref.runnerId) ?? 0) + 1);
    const thresholds: AttentionThresholds = {
      runnerOfflineSec: this.cfg.runnerOfflineSec, jobSilentSec: this.cfg.jobSilentSec, jobSilentErrorSec: this.cfg.jobSilentErrorSec,
      jobStartSec: this.cfg.jobStartSec, jobQueuedWarnSec: this.cfg.jobQueuedWarnSec, credentialExpiryWarnDays: this.cfg.credentialExpiryWarnDays,
    };
    const attention = buildAttention({ scope, runners, heldByRunner, activeJobs: listed, pending, dryRun: { queued, loads, pauses, ...(await this.vaultAvailability(queued, runners)) } }, now, thresholds);
    const runLoads = new Map([...loads].map(([id, load]) => [id, load.active] as const));
    return buildDashboardView({ scope, now, offlineSec: this.cfg.runnerOfflineSec, runners, heldByRunner: runLoads, active, recent, counts, pending, attention });
  }

  /**
   * C10 (branch review B3): the providers the vault can serve each queued job, read once for the whole
   * window. A fleet whose runners report no `providerVault` helper pays no read and the dry-run keeps
   * today's stricter rules, which is the same answer placement gives.
   */
  private async vaultAvailability(
    queued: readonly DashboardJobRow[],
    runners: readonly DashboardRunnerRow[],
  ): Promise<{ vaultProviders?: (job: DashboardJobRow) => ReadonlySet<string> }> {
    if (queued.length === 0 || !runners.some((runner) => runner.capabilities?.providerVault === true)) return {};
    const scopes: ProviderLookupScope[] = queued.map((job) => ({ projectId: job.projectId, repoId: job.repoId }));
    const answers = await this.credentials.availableProviders(scopes);
    return { vaultProviders: (job) => answers.get(providerScopeLookupKey(job)) ?? NO_PROVIDERS };
  }
}
