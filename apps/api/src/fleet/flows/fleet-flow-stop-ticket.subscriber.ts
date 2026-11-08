import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { runAsSystem } from '../../action-context/action-context';
import { bookkeeping } from '../../action-context/audit-coverage';
import { ActorPrincipalLoader, ActorUnavailableError } from '../../auth/principal/actor-principal.loader';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { TicketType } from '../../common/enums';
import { FLEET_FLOW_QUESTIONS, FLEET_FLOW_STOPPED, parseFlowQuestionsPayload, parseFlowStoppedPayload, type FleetFlowQuestionsPayload, type FleetFlowStoppedPayload } from '../../notifications/fleet/fleet-notification-events';
import { formatQuestionsComment } from './flow-calls';
import { FanOutPublisher } from '../../outbox/fan-out-publisher';
import { SystemWriter } from '../../permissions/system-writer.decorator';
import { TicketsService } from '../../tickets/tickets.service';
import { FleetJobTicketEffects } from '../tickets/fleet-job-ticket.effects';
import { FLEET_FLOW_REPOSITORY, type IFleetFlowRepository } from './domain/fleet-flow.domain';
import { FLEET_FLOW_STEP_REPOSITORY, type IFleetFlowStepRepository } from './domain/fleet-flow-step.domain';

/** One lazily created ticket per flow; outbox retries reuse it and deduplicate the exact stop body. */
@Injectable()
@SystemWriter('system.flow.ticket')
export class FleetFlowStopTicketSubscriber implements OnModuleInit {
  private readonly logger = new Logger(FleetFlowStopTicketSubscriber.name);

  constructor(
    private readonly registry: FanOutPublisher,
    @Inject(FLEET_FLOW_REPOSITORY) private readonly flows: IFleetFlowRepository,
    @Inject(FLEET_FLOW_STEP_REPOSITORY) private readonly steps: IFleetFlowStepRepository,
    private readonly actors: ActorPrincipalLoader,
    private readonly tickets: TicketsService,
    private readonly effects: FleetJobTicketEffects,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  onModuleInit(): void {
    this.registry.register(FLEET_FLOW_STOPPED, this.handle);
    this.registry.register(FLEET_FLOW_QUESTIONS, this.handleQuestions);
  }

  readonly handleQuestions = async (payload: unknown): Promise<void> => {
    const p = parseFlowQuestionsPayload(payload);
    if (p === null) {
      this.logger.warn(`${FLEET_FLOW_QUESTIONS}: malformed payload skipped`);
      return;
    }
    await runAsSystem('flow', () => this.questionsTicket(p), {
      onBehalfOf: { type: p.creatorType, id: p.creatorId },
    });
  };

  readonly handle = async (payload: unknown): Promise<void> => {
    const p = parseFlowStoppedPayload(payload);
    if (p === null) {
      this.logger.warn(`${FLEET_FLOW_STOPPED}: malformed payload skipped`);
      return;
    }
    await runAsSystem('flow', () => this.stopTicket(p), {
      onBehalfOf: { type: p.creatorType, id: p.creatorId },
    });
  };

  private async stopTicket(p: FleetFlowStoppedPayload): Promise<void> {
    // Keep the lock through create, null-only link and comment, including the body's dedup read.
    // None of these writes may be deferred: a failed write must roll back and let the outbox retry.
    await this.txManager.run(async () => {
      const flow = await this.flows.lockById(p.flowId);
      if (flow === null) return;
      const slug = await this.steps.projectSlug(p.projectId);
      if (slug === null) return;
      let ticketId = flow.ticketId;
      if (ticketId == null) {
        const principal = await this.author(p);
        if (principal === null) {
          this.logger.warn(`Flow ${p.flowId}: ticket author unavailable; stop ticket skipped`);
          return;
        }
        const ticket = await this.tickets.create(slug, {
          type: TicketType.TASK,
          title: `Fleet flow: ${p.feature}`,
          description: `Flow ${p.flowId} on ${flow.branch}`,
        }, principal);
        ticketId = ticket.id;
        await bookkeeping('fleet.flow-bookkeeping', () => this.steps.setTicket(p.flowId, ticket.id));
      }
      await this.effects.commentOnFlowTicket(ticketId, p.projectId, `Flow stopped (${p.stopReason}): ${p.detail}`);
    });
  }

  private async questionsTicket(p: FleetFlowQuestionsPayload): Promise<void> {
    // Keep the flow lock through ticket creation/linking and comment deduplication, so outbox retries are safe.
    await this.txManager.run(async () => {
      const flow = await this.flows.lockById(p.flowId);
      if (flow === null) return;
      const slug = await this.steps.projectSlug(p.projectId);
      if (slug === null) return;
      let ticketId = flow.ticketId;
      if (ticketId == null) {
        const principal = await this.author(p);
        if (principal === null) {
          this.logger.warn(`Flow ${p.flowId}: ticket author unavailable; questions ticket skipped`);
          return;
        }
        const ticket = await this.tickets.create(slug, {
          type: TicketType.TASK,
          title: `Fleet flow: ${p.feature}`,
          description: `Flow ${p.flowId} on ${flow.branch}`,
        }, principal);
        ticketId = ticket.id;
        await bookkeeping('fleet.flow-bookkeeping', () => this.steps.setTicket(p.flowId, ticket.id));
      }
      const body = formatQuestionsComment({
        step: p.step,
        jobId: p.jobId,
        questions: p.questions,
        answerPath: `/api/projects/${slug}/flows/${p.flowId}/answers`,
      });
      await this.effects.commentOnFlowTicket(ticketId, p.projectId, body);
    });
  }

  private async author(p: FleetFlowStoppedPayload | FleetFlowQuestionsPayload): Promise<KodaPrincipal | null> {
    try {
      return await this.actors.load({ type: p.creatorType, id: p.creatorId });
    } catch (error) {
      if (!(error instanceof ActorUnavailableError)) throw error;
    }
    if (p.approverId === null) return null;
    try {
      return await this.actors.load({ type: 'USER', id: p.approverId });
    } catch (error) {
      if (!(error instanceof ActorUnavailableError)) throw error;
      return null;
    }
  }
}
