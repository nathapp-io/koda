import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { runAsSystemWriter } from '../action-context/action-context';
import { AuditRecorder } from '../audit/audit-recorder.service';
import { FanOutPublisher } from '../outbox/fan-out-publisher';
import { SystemWriter } from '../permissions/system-writer.decorator';
import { parseTicketPrLinkRetryPayload, TICKET_PR_LINK_RETRY } from '../vcs/ticket-pr-link';
import { TicketTransitionsService } from './state-machine/ticket-transitions.service';

/**
 * Review B2 — the durable retry of a classic auto-PR link write.
 *
 * `TicketTransitionsService.createPrForTicket` runs after the VERIFIED transition has committed, so a PR the forge
 * created whose `TicketLink` write failed would never be linked: the ticket is VERIFIED, the workflow has no route
 * back into it, and no other path re-runs that work. The call records this event *before* it touches the forge, and
 * the outbox relay redelivers it (with its own backoff) until the handler completes — so the recovery survives a
 * restart, not just the request.
 *
 * The handler re-runs the recorded repository and branch lookup, which adopts the open PR the forge already has and
 * never creates a second one. When there is nothing left to link the handler succeeds, so a redelivery after a
 * committed link writes nothing; a retryable failure rejects, so the relay retries this same event.
 *
 * Review B6 (fix round 2): the recovered link and the audit entry that records it commit in one transaction. The
 * audit write runs *inside* the link's transaction through `onLinked`: recording it afterwards would leave a link
 * whose audit entry never happened, and the redelivery would then find the link, answer "nothing to do", and skip the
 * audit for good.
 */
@Injectable()
@SystemWriter('system.ticket-link.pr-refresh')
export class TicketPrLinkRetrySubscriber implements OnModuleInit {
  private readonly logger = new Logger(TicketPrLinkRetrySubscriber.name);

  constructor(
    private readonly registry: FanOutPublisher,
    private readonly transitions: TicketTransitionsService,
    private readonly audit: AuditRecorder,
  ) {}

  onModuleInit(): void {
    this.registry.register(TICKET_PR_LINK_RETRY, this.handle.bind(this));
  }

  private async handle(payload: unknown): Promise<void> {
    const retry = parseTicketPrLinkRetryPayload(payload);
    if (retry === null) {
      this.logger.warn(`Skipped a ${TICKET_PR_LINK_RETRY} event without project or ticket ids`);
      return;
    }

    // A domain write of the system's own: the link is written as this component and the entry is recorded here, so
    // the retry is attributed to the ticket-link refresh rather than to the outbox.
    await runAsSystemWriter(this, async () => {
      await this.transitions.retryPrLink(retry, async () => {
        await this.audit.record({
          key: 'system.ticket-link.pr-refresh',
          resourceType: 'ticket',
          resourceId: retry.ticketId,
          projectId: retry.projectId,
          summary: 'linked the open PR of a verified ticket after a failed link write',
        });
      });
    });
  }
}
