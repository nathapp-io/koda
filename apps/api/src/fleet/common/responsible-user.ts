/**
 * Permissions P1d US-002.
 *
 * `FleetActivity.responsibleUserId` names the user a fleet write is answerable to. A job requested by a
 * user answers with that user; a job requested by an agent answers null (P2's `AuditEntry` replaces the
 * column with on-behalf-of). A record written before `requestedByType` existed has no type, so it is a
 * user's — every fleet requester was one until agents could dispatch.
 */
export function responsibleUserOf(job: { requestedById: string; requestedByType?: string }): string | null {
  return job.requestedByType === 'AGENT' ? null : job.requestedById;
}
