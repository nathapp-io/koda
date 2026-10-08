import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { OutboxService } from '@nathapp/nestjs-outbox';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { isRunnerOnline } from '../../fleet/common/runner-online';
import { readCapabilities } from '../../fleet/dashboard/dashboard-view';
import { FleetHealthAlertsRepository } from './fleet-health-alerts.repository';
import { planHealthChanges } from './fleet-health-plan';
import { FLEET_HEALTH_ALERT, FleetHealthAlertPayload } from './fleet-notification-events';

const DETECT_INTERVAL_MS = 60_000;
type HealthConfig = Pick<IFleetConfig, 'sweepEnabled' | 'runnerOfflineSec' | 'credentialExpiryWarnDays'>;

/**
 * Fleet S4a §2.4 (D507, D515): opens and closes runner-offline and credential-expiring episodes every 60 s,
 * in process (single API instance), like FleetSweeper. Each opened episode and its fleet_health_alert event
 * commit in one transaction. For the first runnerOfflineSec after boot, offline checks are skipped: every
 * runner's lastSeenAt is stale after an API restart until it syncs again.
 */
@Injectable()
export class FleetHealthDetector implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FleetHealthDetector.name);
  private readonly bootedAtMs = Date.now();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly repo: FleetHealthAlertsRepository,
    private readonly outbox: OutboxService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    @Inject(FLEET_CFG) private readonly cfg: HealthConfig,
  ) {}

  onModuleInit(): void {
    if (!this.cfg.sweepEnabled) return;
    this.timer = setInterval(() => {
      this.detect().catch((error: unknown) => this.logger.error(`Fleet health detect failed: ${error instanceof Error ? error.message : String(error)}`));
    }, DETECT_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async detect(now = new Date()): Promise<{ opened: number; closed: number }> {
    const [rows, openAlerts] = await Promise.all([this.repo.findRunners(), this.repo.findOpen()]);
    const plan = planHealthChanges({
      runners: rows.map((r) => ({
        id: r.id, name: r.name, enabled: r.enabled,
        online: isRunnerOnline(r.lastSeenAt, now, this.cfg.runnerOfflineSec),
        capabilities: readCapabilities(r.capabilities),
      })),
      openAlerts,
      now,
      warnDays: this.cfg.credentialExpiryWarnDays,
      inBootGrace: now.getTime() < this.bootedAtMs + this.cfg.runnerOfflineSec * 1000,
    });
    let opened = 0;
    for (const req of plan.open) {
      const done = await this.txManager.run(async () => {
        const alertId = await this.repo.open(req.kind, req.subjectKey, now);
        if (!alertId) return false;
        const payload: FleetHealthAlertPayload = { alertId, kind: req.kind, runner: req.runner, provider: req.provider, expiresAt: req.expiresAt };
        await this.outbox.record({ type: FLEET_HEALTH_ALERT, payload, metadata: { eventId: alertId } });
        return true;
      });
      if (done) opened += 1;
    }
    const closed = plan.close.length > 0 ? await this.repo.close(plan.close, now) : 0;
    return { opened, closed };
  }
}
