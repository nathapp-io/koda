import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { runAsSystem } from '../../action-context/action-context';
import { FLEET_CFG, type IFleetConfig } from '../../config/fleet.config';
import { SystemWriter } from '../../permissions/system-writer.decorator';
import { FLEET_FLOW_STEP_REPOSITORY, type IFleetFlowStepRepository } from './domain/fleet-flow-step.domain';
import { FleetFlowAdvanceService } from './fleet-flow-advance.service';

const PAGE_SIZE = 50;
const MAX_PAGES = 10;
export const FLOW_FAILURE_STOP_AFTER = 5;
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** The only flow trigger: a bounded pass, single-flight within this API process. */
@Injectable()
@SystemWriter('system.flow.advance')
export class FleetFlowTicker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FleetFlowTicker.name);
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private afterId: string | null = null;
  private readonly failures = new Map<string, number>();

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
    const startingAfterId = this.afterId;
    const listed = new Set<string>();
    let afterId = startingAfterId;
    let reachedShortPage = false;

    for (let page = 0; page < MAX_PAGES; page++) {
      const flows = await this.steps.listAdvanceable(PAGE_SIZE, afterId);
      for (const flow of flows) {
        listed.add(flow.id);
        const behalf = { type: flow.createdByType, id: flow.createdById };
        try {
          await runAsSystem('flow', () => this.engine.advance(flow.id, now), { onBehalfOf: behalf });
          this.failures.delete(flow.id);
        } catch (error) {
          this.logger.error(`Flow ${flow.id} failed: ${messageOf(error)}`);
          const failures = (this.failures.get(flow.id) ?? 0) + 1;
          this.failures.set(flow.id, failures);
          if (failures >= FLOW_FAILURE_STOP_AFTER) {
            try {
              await runAsSystem('flow', () => this.engine.stopFailedFlow(flow.id, messageOf(error), now), {
                onBehalfOf: behalf,
              });
              this.failures.delete(flow.id);
            } catch (stopError) {
              this.logger.error(`Flow ${flow.id} failed to stop: ${messageOf(stopError)}`);
            }
          }
        }
      }
      if (flows.length < PAGE_SIZE) {
        reachedShortPage = true;
        afterId = null;
        break;
      }
      afterId = flows[flows.length - 1].id;
    }

    if (startingAfterId === null && reachedShortPage) {
      for (const flowId of this.failures.keys()) {
        if (!listed.has(flowId)) this.failures.delete(flowId);
      }
    }
    this.afterId = afterId;
    if (!reachedShortPage) {
      this.logger.warn(`Flow tick reached its ${PAGE_SIZE * MAX_PAGES}-flow limit; remaining flows wait for the next tick`);
    }
  }
}
