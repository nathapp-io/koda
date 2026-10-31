/**
 * Permissions P2l US-002 — the typed catalogue of intentionally uncounted bookkeeping writes.
 * Each sentence explains the narrow write path that a caller marks with `bookkeeping()`.
 */
export const BOOKKEEPING_REASONS = {
  'runner.heartbeat': "A runner's liveness, boot id, versions and capabilities from a sync.",
  'runner.command-delivery': 'The delivered mark of a command handed to a runner.',
  'runner.command-ack': "A runner's ack of a command, and an approval answer's delivery outcome, that change no job.",
  'thread.input-ack': "A runner's ack of a thread input, answer or publish command: the message's error mark, the answered question cleared, the command payload trimmed.",
  'runner.event-log': "Runner event rows, the acked sequence, the job fields mirrored from the runner's reported run facts (cost, progress, `naxRunId`, result branch, sha and PR url, finish result, escalation reason, post-run, stories, config result), and a rejected event's activity row; the state transition that ends a run records its own entry.",
  'runner.fence-abandon': 'The ABANDON command and activity row a fence queues for a stale holder.',
  'runner.boot-reconcile': "A pending ASSIGN's boot id moved to the runner's new boot.",
  'fleet.placement': 'A job or thread assigned to a runner: the lease, the ASSIGN command, the thread pin and the assigned row.',
  'fleet.pr-link-job': 'The job id refreshed on a PR link that already exists.',
  'fleet.ticket-comment-claim': 'The once-per-job-epoch claim before a failure comment; the comment records `comment.create`.',
  'fleet.pr-attribution-claim': 'The once-per-job claim before the attribution comment.',
  'fleet.log-chunk': 'The stream metadata of an uploaded log chunk.',
  'thread.transcript': "The thread transcript folded from a runner's stream, and the ingest cursor; a `turn_end` records `system.thread.ingest` itself.",
  'fleet.ingest-queue': 'A bundle ingest claim, retry or failure mark.',
  'fleet.ingest-progress': 'The activity row reporting how many bundles a backfill or rerun queued, including zero.',
  'fleet.analytics-progress': 'The activity row reporting analytics deletion counts, including a deletion that found no rows.',
  'fleet.schedule-bookkeeping': "A schedule's fire claim, a skip or coalesce activity row, and the last dispatched job link.",
  'fleet.pr-review-bookkeeping': "A PR review head's claim, dispatched link, failure mark or stale-claim removal; the dispatch it follows records `system.pr-review.dispatch`.",
  'fleet.review-event-bookkeeping': 'A review event marked minted or skipped, or its failed mint attempt count incremented; the decision records system.review.decision itself.',
  'assistant.tool-call-ledger': 'The tool-call ledger row every assistant tool call stores, read or write.',
  'assistant.action-request-link': "The thread link of a waiting assistant write: its thread, job, tool call, tool and preview; the request is `approval.request-open`.",
  'email.template-seed': 'The built-in email templates written from code at boot; the code is their source.',
  'vcs.poll-log': "A VCS poll's sync log row and cursor.",
  'webhook.replay-record': 'A webhook delivery id kept or forgotten for replay protection.',
  'vcs.push-outbox': 'The `code_commit` outbox rows a push enqueues; the code-intel subscriber records the index.',
  'vcs.pr-same-state': 'A PR webhook that restates the stored state, touching only `prUpdatedAt`.',
  'vcs.link-refresh': "The extractor's refresh of a ticket link that already exists.",
  'context.query-metric': "A context query's latency and result metric row.",
  'approval.request-open': 'An approval request opened by the gate; the decision records `approval.decide`.',
  'approval.request-settle': "An approval request's terminal status and result; the command records its own key and the expiry records `system.approval.expire`.",
} as const;

export type BookkeepingReason = keyof typeof BOOKKEEPING_REASONS;
