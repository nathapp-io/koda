import { Reflector } from '@nestjs/core';
import { PERMISSION_CATALOG } from './catalog';
import { SYSTEM_WRITER_METADATA, SystemWriter } from './system-writer.decorator';
import { EmailDispatcher } from '../email/email-dispatcher';
import { ApprovalRequestExpirySweeper } from '../approvals/approval-request-expiry.sweeper';
import { BudgetSweeper } from '../fleet/budgets/budget-sweeper';
import { BundleIngestSweeper } from '../fleet/ingest/bundle-ingest.sweeper';
import { KnowledgePoller } from '../fleet/knowledge/knowledge-poller';
import { KnowledgeIndexQueue } from '../fleet/knowledge/knowledge-index.queue';
import { FleetLogRetentionProcessor } from '../fleet/logs/fleet-log-retention.processor';
import { EnrollmentRetentionProcessor } from '../fleet/runners/enrollment-retention.processor';
import { ScheduleTicker } from '../fleet/schedules/schedule-ticker';
import { FleetPrReviewPass } from '../fleet/reviews/fleet-pr-review.pass';
import { FleetSweeper } from '../fleet/sync/fleet-sweeper';
import { FleetPrStateRefresher } from '../fleet/tickets/fleet-pr-state.refresher';
import { FleetHealthDetector } from '../notifications/fleet/fleet-health.detector';
import { MemoryGovernanceProcessor } from '../memory/memory-governance.processor';
import { NotificationRetentionProcessor } from '../notifications/notification-retention.processor';
import { OutboxRetentionProcessor } from '../outbox/outbox-retention.processor';
import { CronOptimizeStrategy } from '../rag/strategies/cron-optimize.strategy';
import { CounterOptimizeStrategy } from '../rag/strategies/counter-optimize.strategy';
import { ManualOptimizeStrategy } from '../rag/strategies/manual-optimize.strategy';
import { VcsPollingService } from '../vcs/vcs-polling.service';
import { VcsPrSyncService } from '../vcs/vcs-pr-sync.service';
import { VcsWebhookService } from '../vcs/vcs-webhook.service';
import { CiWebhookService } from '../ci-webhook/ci-webhook.service';
import { WebhookDeliveryHandler } from '../webhook/webhook-delivery.handler';
import { MemoryOutboxSubscriber } from '../memory/memory-outbox.subscriber';
import { KbTicketLifecycleSubscriber } from '../rag/kb-ticket-lifecycle.subscriber';
import { EntityGraphOutboxSubscriber } from '../entity-graph/entity-graph-outbox.subscriber';
import { CodeIntelOutboxSubscriber } from '../code-intel/code-intel-outbox.subscriber';
import { TicketNotificationSubscriber } from '../notifications/ticket-notification.subscriber';
import { FleetBudgetIncidentSubscriber } from '../notifications/fleet/fleet-budget-incident.subscriber';
import { FleetHealthAlertSubscriber } from '../notifications/fleet/fleet-health-alert.subscriber';
import { FleetJobOutcomeSubscriber } from '../notifications/fleet/fleet-job-outcome.subscriber';
import { AssistantActionOutcomeSubscriber } from '../fleet/assistant/requests/assistant-action-outcome.subscriber';
import { ThreadIngestHook } from '../fleet/threads/ingest/thread-ingest.module';
import { FanOutPublisher } from '../outbox/fan-out-publisher';

const writers = new Map<Function, string>([
  [EmailDispatcher, 'system.email.dispatch'],
  // US-012: the approval engine's own expiry sweep is the only declarer of the key.
  [ApprovalRequestExpirySweeper, 'system.approval.expire'],
  [BudgetSweeper, 'system.budget.window-reset'],
  [BundleIngestSweeper, 'system.ingest.drain'],
  [KnowledgePoller, 'system.knowledge.poll'],
  [KnowledgeIndexQueue, 'system.knowledge.index'],
  [FleetLogRetentionProcessor, 'system.log.retention'],
  [EnrollmentRetentionProcessor, 'system.enrollment.retention'],
  [ScheduleTicker, 'system.schedule.dispatch'],
  [FleetPrReviewPass, 'system.pr-review.dispatch'],
  [FleetSweeper, 'system.job.crash-silent-runner'],
  [FleetPrStateRefresher, 'system.ticket-link.pr-refresh'],
  [FleetHealthDetector, 'system.health.detect'],
  [MemoryGovernanceProcessor, 'system.memory.govern'],
  [NotificationRetentionProcessor, 'system.notification.retention'],
  [OutboxRetentionProcessor, 'system.outbox.retention'],
  [CronOptimizeStrategy, 'system.rag.optimize'],
  [CounterOptimizeStrategy, 'system.rag.optimize'],
  [ManualOptimizeStrategy, 'system.rag.optimize'],
  [VcsPollingService, 'system.vcs.poll-issues'],
  [VcsPrSyncService, 'system.vcs.pr-merge-transition'],
  [VcsWebhookService, 'system.vcs.webhook-intake'],
  [CiWebhookService, 'system.ci.ticket-create'],
  [WebhookDeliveryHandler, 'system.webhook.deliver'],
  [MemoryOutboxSubscriber, 'system.memory.extract-from-event'],
  [KbTicketLifecycleSubscriber, 'system.kb.ticket-index'],
  [EntityGraphOutboxSubscriber, 'system.entity-graph.write'],
  [CodeIntelOutboxSubscriber, 'system.codeintel.index-commit'],
  [TicketNotificationSubscriber, 'system.notification.ticket'],
  [FleetBudgetIncidentSubscriber, 'system.notification.fleet'],
  [FleetHealthAlertSubscriber, 'system.notification.fleet'],
  [FleetJobOutcomeSubscriber, 'system.notification.fleet'],
  [ThreadIngestHook, 'system.thread.ingest'],
  [AssistantActionOutcomeSubscriber, 'system.thread.ingest'],
  [FanOutPublisher, 'system.outbox.dispatch'],
]);

const reflector = new Reflector();

describe('@SystemWriter', () => {
  it('AC-1: puts the system catalog key on a decorated class', () => {
    class Writer {}
    SystemWriter('system.outbox.retention')(Writer);
    expect(reflector.get(SYSTEM_WRITER_METADATA, Writer)).toBe('system.outbox.retention');
  });

  it('AC-2: rejects a role key at decoration factory time', () => {
    expect(() => SystemWriter('ticket.read')).toThrow(expect.objectContaining({ message: expect.stringContaining('ticket.read') }));
  });

  it('AC-3: rejects an unknown system key at decoration factory time', () => {
    expect(() => SystemWriter('system.no-such-writer')).toThrow(
      expect.objectContaining({ message: expect.stringContaining('system.no-such-writer') }),
    );
  });

  it('AC-4: reads the complete class-to-key declaration map', () => {
    const actual = new Map([...writers].map(([writer]) => [writer.name, reflector.get<string>(SYSTEM_WRITER_METADATA, writer)]));
    const expected = new Map([...writers].map(([writer, key]) => [writer.name, key]));
    expect(writers).toHaveLength(35);
    expect(actual).toEqual(expected);
  });

  it('AC-5: declares every system catalog key and no other key', () => {
    const declared = new Set([...writers.values()]);
    const systemKeys = new Set(PERMISSION_CATALOG.filter(({ access }) => access === 'system').map(({ key }) => key));
    expect(declared).toEqual(systemKeys);
  });
});
