/**
 * Permissions P2l US-001 — the reasoned allowlist of entry points that only ever write bookkeeping.
 *
 * A surface is an entry point label: `<METHOD> /<path>` for an HTTP route (exactly as the permission
 * contract test prints it), `writer:<ClassName>` for a `runAsSystemWriter` run, and `system:<id>` for
 * a `runAsSystem` run. A scope whose label is on this map is not checked, so a surface that writes
 * bookkeeping and nothing else does not have to record an entry nothing would read.
 *
 * A surface that writes both kinds stays off this map and marks its bookkeeping calls with
 * `bookkeeping(...)` instead (US-002); a new outbox handler that makes a domain write must open its
 * own writer scope, which is a review rule, not a check.
 */
export const UNAUDITED_SURFACES: ReadonlyMap<string, string> = new Map<string, string>([
  [
    'POST /me/notifications/:id/read',
    "Marks one of the caller's own notifications read; inbox state, not a domain change.",
  ],
  [
    'POST /me/notifications/read-all',
    "Marks the caller's own notifications read; inbox state, not a domain change.",
  ],
  [
    'system:outbox',
    'Runs each outbox fan-out handler; the handlers that run here write delivery bookkeeping ' +
      '(notification rows and watchers, the KB ticket index, the entity graph projection, the ' +
      "webhook send, the handler's `lastError`), and the recording handlers open their own writer scope.",
  ],
  ['writer:PrismaOutboxStore', "The outbox relay's published, retry and dead marks."],
  [
    'writer:EmailDispatcher',
    'An email claimed, sent, skipped, failed or backed off, and abandoned invite sends closed.',
  ],
  [
    'system:knowledge',
    'A knowledge index pass: claims, leases and per-file rows of a derived index; a successful ' +
      'pass also records `system.knowledge.index`.',
  ],
  ['system:unknown', "The context guard's production fallback, which already logged `ContextlessWriteError`."],
]);
