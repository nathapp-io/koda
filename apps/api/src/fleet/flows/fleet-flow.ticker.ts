import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { runAsSystem } from '../../action-context/action-context';
import { FLEET_CFG, type IFleetConfig } from '../../config/fleet.config';
import { SystemWriter } from '../../permissions/system-writer.decorator';
import { FLEET_FLOW_STEP_REPOSITORY, type IFleetFlowStepRepository } from './domain/fleet-flow-step.domain';
import { FleetFlowAdvanceService } from './fleet-flow-advance.service';

const PAGE_SIZE = 50;
const MAX_PAGES = 10;
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** The only flow trigger: a bounded pass, single-flight within this API process. */
@Injectable()
@SystemWriter('system.flow.advance')
export class FleetFlowTicker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FleetFlowTicker.name);
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(
    @Inject(FLEET_FLOW_STEP_REPOSITORY) private readonly steps: IFleetFlowStepRepository,
    private readonly engine: FleetFlowAdvanceService,
    @Inject(FLEET_CFG) private readonly config: Pick<IFleetConfig, 'sweepEnabled' | 'flowTickMs'>,
  ) {}

  onModuleInit(): void {
    if (!this.config.sweepEnabled) return;
    this.timer = setInterval(() => {
      this.poll().catch((error: unknown) => this.logger.error(`Flow tick failed: ${messageOf(error)}`));
    }, this.config.flowTickMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.tick(new Date());
    } finally {
      this.polling = false;
    }
  }

  async tick(now: Date): Promise<void> {
    let afterId: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const flows = await this.steps.listAdvanceable(PAGE_SIZE, afterId);
      for (const flow of flows) {
        try {
          await runAsSystem('flow', () => this.engine.advance(flow.id, now), {
            onBehalfOf: { type: flow.createdByType, id: flow.createdById },
          });
        } catch (error) {
          this.logger.error(`Flow ${flow.id} failed: ${messageOf(error)}`);
        }
      }
      if (flows.length < PAGE_SIZE) return;
      afterId = flows[flows.length - 1].id;
    }
    this.logger.warn(`Flow tick reached its ${PAGE_SIZE * MAX_PAGES}-flow limit; remaining flows wait for the next tick`);
  }
}
