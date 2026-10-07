import { Inject, Injectable, Logger } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { TicketStatus } from '../../common/enums';
import { TicketTransitionsService } from '../../tickets/state-machine/ticket-transitions.service';
import { prNumberFor } from '../sync/pr-attribution.service';
import type { DispatchTicket, TicketActor } from './fleet-tickets.service';
import { FleetTicketEventRecorder } from './fleet-ticket-event.recorder';
import { FAILURE_STATES, failureCommentBody } from './failure-comment';
import { PrismaFleetTicketsRepository } from './prisma-fleet-tickets.repository';
import type { EffectJob, LinkedTicket, PrLinkJob } from './prisma-fleet-tickets.repository';

export type { TicketActor } from './fleet-tickets.service';

const STARTABLE: ReadonlySet<string> = new Set([TicketStatus.CREATED, TicketStatus.VERIFIED]);

/** Fleet C9 §3: ticket-side effects of fleet jobs. After commit, best-effort per ticket, never throws (D451). */
@Injectable()
export class FleetJobTicketEffects {
  private readonly logger = new Logger(FleetJobTicketEffects.name);

  constructor(
    private readonly transitions: TicketTransitionsService,
    private readonly repo: PrismaFleetTicketsRepository,
    private readonly events: FleetTicketEventRecorder,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  /** D452: a RUN dispatch starts each CREATED/VERIFIED ticket as the requester; PLAN callers never call this. */
  async onRunDispatched(actor: TicketActor, tickets: readonly DispatchTicket[]): Promise<void> {
    for (const ticket of tickets.filter((t) => STARTABLE.has(t.status))) {
      try {
        await this.transitions.start(actor.projectSlug, ticket.ref, actor.principal);
      } catch (error) {
        this.logger.warn(`Fleet ticket ${ticket.ref}: start failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** D453/D454/D455: after commit, from sync afterTerminal and the sweeper. Failure comment, then the PR link. */
  async onTerminal(jobIds: readonly string[]): Promise<void> {
    for (const jobId of new Set(jobIds)) {
      await this.commentOnFailure(jobId);
      await this.upsertPrLinks(jobId);
    }
  }

  /** C9 §3.3 (D455): the job's PR as a `pr` link on each linked ticket. Also after ingest fills resultPrUrl. Never throws. */
  async upsertPrLinks(jobId: string): Promise<void> {
    try {
      const job = await this.repo.findJobForPrLinks(jobId);
      if (!job?.resultPrUrl) return;
      const prNumber = prNumberFor(job.repo, job.resultPrUrl);
      if (prNumber === null) {
        this.logger.warn(`Fleet job ${jobId}: resultPrUrl does not name ${job.repo.owner}/${job.repo.name}; no PR link`);
        return;
      }
      for (const ticket of await this.repo.findTicketsForJob(jobId)) {
        await this.linkPr(job, ticket, prNumber);
      }
    } catch (error) {
      this.logger.warn(`Fleet job ${jobId}: PR links failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async commentOnFailure(jobId: string): Promise<void> {
    try {
      const job = await this.repo.findJobForEffects(jobId);
      if (!job || !FAILURE_STATES.has(job.state)) return;
      const body = failureCommentBody(job);
      for (const ticket of await this.repo.findTicketsForJob(jobId)) {
        await this.commentOnce(job, ticket, body);
      }
    } catch (error) {
      this.logger.warn(`Fleet job ${jobId}: ticket effects failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async linkPr(job: PrLinkJob, ticket: LinkedTicket, prNumber: number): Promise<void> {
    const url = job.resultPrUrl as string;
    try {
      await this.txManager.run(async () => {
        const created = await this.repo.upsertFleetPrLink({
          ticketId: ticket.ticketId, jobId: job.id, url, provider: job.repo.provider, prNumber,
          externalRef: `${job.repo.owner}/${job.repo.name}#${prNumber}`, now: new Date(),
        });
        if (!created) return;
        await this.events.record({ projectId: job.projectId, ticketId: ticket.ticketId, action: 'TICKET_UPDATED', actorId: job.requestedById, data: { fleetPrLinked: url, jobId: job.id } });
      });
    } catch (error) {
      this.logger.warn(`Fleet job ${job.id}: PR link on ticket ${ticket.ref} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async commentOnce(job: EffectJob, ticket: LinkedTicket, body: string): Promise<void> {
    try {
      await this.txManager.run(async () => {
        if (!(await this.repo.claimNotified(job.id, ticket.ticketId, job.leaseEpoch))) return;
        const comment = await this.repo.createSystemComment(ticket.ticketId, body);
        await this.events.record({ projectId: job.projectId, ticketId: ticket.ticketId, action: 'COMMENT_ADDED', actorId: job.requestedById, data: { commentId: comment.id } });
      });
    } catch (error) {
      this.logger.warn(`Fleet job ${job.id}: comment on ticket ${ticket.ref} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
