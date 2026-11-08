import { Inject, Injectable, Logger } from '@nestjs/common';
import { bookkeeping, runInAuditScope } from '../../action-context/audit-coverage';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { CommentType, TicketStatus, TicketType } from '../../common/enums';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { TicketsService } from '../../tickets/tickets.service';
import { FleetTicketsService } from './fleet-tickets.service';
import { AfterCommitService } from '../../permissions/after-commit.service';
import { AuditRecorder } from '../../audit/audit-recorder.service';
import { TicketTransitionsService } from '../../tickets/state-machine/ticket-transitions.service';
import { prNumberFor } from '../sync/pr-attribution.service';
import type { DispatchTicket, TicketActor } from './fleet-tickets.service';
import { FleetTicketEventRecorder } from './fleet-ticket-event.recorder';
import { FAILURE_STATES, failureCommentBody } from './failure-comment';
import { PrismaFleetTicketsRepository } from './prisma-fleet-tickets.repository';
import type { EffectJob, LinkedTicket, PrLinkJob } from './prisma-fleet-tickets.repository';

export type { TicketActor } from './fleet-tickets.service';

const STARTABLE: ReadonlySet<string> = new Set([TicketStatus.CREATED, TicketStatus.VERIFIED]);

/**
 * US-002: these effects run after commit, often outside any request, so the action context cannot say who the
 * requester was. An agent-requested job's ticket events name the agent; a user's leave it to the recorder.
 */
const agentTypeOf = (job: { requestedByType?: 'USER' | 'AGENT' }): { actorType?: 'agent' } =>
  job.requestedByType === 'AGENT' ? { actorType: 'agent' } : {};

/** Fleet ticket effects: legacy terminal/dispatch effects are best-effort; ruling effects are transactional. */
@Injectable()
export class FleetJobTicketEffects {
  private readonly logger = new Logger(FleetJobTicketEffects.name);

  constructor(
    private readonly transitions: TicketTransitionsService,
    private readonly repo: PrismaFleetTicketsRepository,
    private readonly events: FleetTicketEventRecorder,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    private readonly audit: AuditRecorder,
    private readonly afterCommit: AfterCommitService,
    private readonly tickets: TicketsService,
    private readonly fleetTickets: FleetTicketsService,
  ) {}

  /** Rulings are atomic: call inside the ruling transaction; never defer or swallow failures. */
  async ensureFinishTicket(job: { id: string }, principal: KodaPrincipal): Promise<string> {
    await this.repo.lockJobRow(job.id);
    const existing = await this.repo.findEligibleFinishTicket(job.id);
    if (existing) return existing.ticketId;
    const run = await this.repo.findJobForFinishTicket(job.id);
    if (!run) throw new NotFoundAppException({}, 'fleet.jobs');
    const prNumber = run.resultPrUrl ? prNumberFor(run.repo, run.resultPrUrl) : null;
    if (prNumber === null || !run.resultPrUrl) throw new ConflictAppException({}, 'fleet.rulings.notDraft');
    const ticket = await this.tickets.create(run.projectSlug, {
      type: TicketType.TASK, title: `Finish draft PR #${prNumber} (${run.feature})`,
    }, principal);
    await this.transitions.startForDispatch(run.projectSlug, ticket.ref, principal);
    await this.fleetTickets.link(run.id, [ticket]);
    await this.repo.upsertFleetPrLink({
      ticketId: ticket.id, jobId: run.id, url: run.resultPrUrl, provider: run.repo.provider, prNumber,
      externalRef: `${run.repo.owner}/${run.repo.name}#${prNumber}`, now: new Date(),
    });
    return ticket.id;
  }

  /** System-authored ruling comment used by flow rulings inside the ruling transaction. */
  createSystemRulingComment(ticketId: string, body: string): Promise<{ id: string }> {
    return this.repo.createSystemComment(ticketId, body, CommentType.RULING);
  }

  /** Authored as the ruling principal, inside the same transaction (fleet.job.rule is sufficient). */
  createRulingComment(ticketId: string, body: string, principal: KodaPrincipal): Promise<{ id: string }> {
    return this.repo.createRulingComment(ticketId, body, principal);
  }

  commentOnRulingResult(runId: string, body: string): Promise<void> {
    return this.commentOnFinish(runId, body, CommentType.RULING);
  }

  commentOnReady(runId: string, body: string): Promise<void> {
    return this.commentOnFinish(runId, body, CommentType.GENERAL);
  }

  /** Caller holds the flow lock and transaction; failures must reach the outbox for retry. */
  async commentOnFlowTicket(ticketId: string, projectId: string, body: string): Promise<void> {
    if (await this.repo.hasCommentBody(ticketId, body)) return;
    const comment = await this.repo.createSystemComment(ticketId, body, CommentType.GENERAL);
    await this.audit.record({
      key: 'comment.create', resourceType: 'comment', resourceId: comment.id, projectId, summary: `on ${ticketId}`,
    });
  }

  /** Called inside FIX ingest's transaction and job lock, never via the failure notifiedEpoch claim. */
  private async commentOnFinish(runId: string, body: string, type: CommentType): Promise<void> {
    const job = await this.repo.findJobForEffects(runId);
    if (!job) return;
    for (const ticket of await this.repo.findTicketsForJob(runId)) {
      if (await this.repo.hasCommentBody(ticket.ticketId, body)) continue;
      const comment = await this.repo.createSystemComment(ticket.ticketId, body, type);
      await this.audit.record({ key: 'comment.create', resourceType: 'comment', resourceId: comment.id, projectId: job.projectId, summary: `on ${ticket.ref}` });
    }
  }

  /**
   * D452: a RUN dispatch starts each CREATED/VERIFIED ticket as the requester; PLAN callers never call
   * this. Permissions P1d (US-003): it goes through `startForDispatch`, because the caller was
   * authorized for `fleet.job.dispatch` and not for the ticket's edge key.
   */
  async onRunDispatched(actor: TicketActor, tickets: readonly DispatchTicket[]): Promise<void> {
    const start = async () => {
      for (const ticket of tickets.filter((t) => STARTABLE.has(t.status))) {
        try {
          await this.transitions.startForDispatch(actor.projectSlug, ticket.ref, actor.principal);
        } catch (error) {
          this.logger.warn(`Fleet ticket ${ticket.ref}: start failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    };
    // Approval execution owns the outer commit; a failed start must never poison its transaction.
    if (!this.afterCommit.defer(start)) await start();
  }

  /** D453/D454/D455: after commit, from sync afterTerminal and the sweeper. Failure comment, then the PR link. */
  async onTerminal(jobIds: readonly string[]): Promise<void> {
    return runInAuditScope('task:FleetJobTicketEffects.onTerminal', async () => {
      for (const jobId of new Set(jobIds)) {
        await this.commentOnFailure(jobId);
        await this.upsertPrLinks(jobId);
      }
    }, { detached: true });
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
        const linkId = await this.repo.upsertFleetPrLink({
          ticketId: ticket.ticketId, jobId: job.id, url, provider: job.repo.provider, prNumber,
          externalRef: `${job.repo.owner}/${job.repo.name}#${prNumber}`, now: new Date(),
        });
        if (linkId === null) return;
        await this.events.record({
          projectId: job.projectId, ticketId: ticket.ticketId, action: 'TICKET_UPDATED', actorId: job.requestedById,
          ...agentTypeOf(job), data: { fleetPrLinked: url, jobId: job.id },
        });
        // Permissions P2 US-005: a link the fleet created is a derived write; the update branch
        // (an existing link gaining the job id) is bookkeeping and records nothing.
        await this.audit.record({
          key: 'ticket.link.add', resourceType: 'ticket-link', resourceId: linkId,
          projectId: job.projectId, summary: `on ${ticket.ref}`,
        });
      });
    } catch (error) {
      this.logger.warn(`Fleet job ${job.id}: PR link on ticket ${ticket.ref} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async commentOnce(job: EffectJob, ticket: LinkedTicket, body: string): Promise<void> {
    try {
      await this.txManager.run(async () => {
        if (!(await bookkeeping('fleet.ticket-comment-claim', () => this.repo.claimNotified(job.id, ticket.ticketId, job.leaseEpoch)))) return;
        const comment = await this.repo.createSystemComment(ticket.ticketId, body);
        await this.events.record({
          projectId: job.projectId, ticketId: ticket.ticketId, action: 'COMMENT_ADDED', actorId: job.requestedById,
          ...agentTypeOf(job), data: { commentId: comment.id },
        });
        // Permissions P2 US-005: the failure comment is a write an outside system caused.
        await this.audit.record({
          key: 'comment.create', resourceType: 'comment', resourceId: comment.id,
          projectId: job.projectId, summary: `on ${ticket.ref}`,
        });
      });
    } catch (error) {
      this.logger.warn(`Fleet job ${job.id}: comment on ticket ${ticket.ref} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
