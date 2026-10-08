import type { WatchReason } from './notification.types';
import type { TicketNotificationKind } from './ticket-notification-text';

export type HandledTicketAction = 'TICKET_CREATED' | 'assigned' | 'COMMENT_ADDED' | 'status_changed';

export const HANDLED_TICKET_ACTIONS: ReadonlySet<string> = new Set<HandledTicketAction>(['TICKET_CREATED', 'assigned', 'COMMENT_ADDED', 'status_changed']);

export interface TicketEventFacts {
  action: HandledTicketAction;
  reporterId: string | null;
  assigneeUserId: string | null;
  commentAuthorId: string | null;
  mentionedIds: readonly string[];
}

export interface TicketRecipient {
  userId: string;
  kind: TicketNotificationKind;
}

const watch = (userId: string | null, reason: WatchReason) => (userId ? [{ userId, reason }] : []);
const mentioned = (f: TicketEventFacts) => f.mentionedIds.map((userId) => ({ userId, reason: 'MENTIONED' as const }));

/** S4a §2.2: who becomes a watcher because of this event (insert-if-absent; D502). */
export function watchEntries(f: TicketEventFacts): readonly { userId: string; reason: WatchReason }[] {
  switch (f.action) {
    case 'TICKET_CREATED': return [...watch(f.reporterId, 'REPORTER'), ...mentioned(f)];
    case 'assigned': return watch(f.assigneeUserId, 'ASSIGNEE');
    case 'COMMENT_ADDED': return [...watch(f.commentAuthorId, 'COMMENTER'), ...mentioned(f)];
    case 'status_changed': return [];
  }
}

/**
 * S4a §2.2: one notification per user per event, priority ASSIGNED > MENTIONED > WATCHED_ACTIVITY.
 * Assignment and mentions ignore mute (callers pass mentions separately); watched activity uses only
 * the unmuted watcher list. The actor is dropped later by NotificationEligibility.
 */
export function ticketRecipients(f: TicketEventFacts, unmutedWatcherIds: readonly string[]): readonly TicketRecipient[] {
  const direct: TicketRecipient[] = f.action === 'assigned'
    ? (f.assigneeUserId ? [{ userId: f.assigneeUserId, kind: 'ticket_assigned' }] : [])
    : f.mentionedIds.map((userId) => ({ userId, kind: 'ticket_mentioned' as const }));
  const activityKind: TicketNotificationKind | null =
    f.action === 'COMMENT_ADDED' ? 'ticket_commented' : f.action === 'status_changed' ? 'ticket_status_changed' : null;
  const activity: TicketRecipient[] = activityKind === null ? [] : unmutedWatcherIds.map((userId) => ({ userId, kind: activityKind }));
  return [...direct, ...activity].reduce<TicketRecipient[]>(
    (acc, r) => (acc.some((x) => x.userId === r.userId) ? acc : [...acc, r]),
    [],
  );
}
