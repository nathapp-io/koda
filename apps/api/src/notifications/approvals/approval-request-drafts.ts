import { type NotificationDraft, TITLE_MAX, truncate } from '../notification.types';

/** English fallback text; clients render the kind and params in their own locale. */
export function approvalRequestDrafts(
  userIds: readonly string[],
  r: { requestId: string; projectId: string | null; permissionKey: string },
): NotificationDraft[] {
  return userIds.map((userId) => ({
    userId, projectId: r.projectId, category: 'FLEET_NEEDS_YOU', kind: 'approval_request',
    title: truncate(`Approval needed: ${r.permissionKey}`, TITLE_MAX), body: null,
    link: `/approvals?id=${r.requestId}`, params: { key: r.permissionKey },
    sourceType: 'approval_request', sourceId: r.requestId, actorId: null,
  }));
}
