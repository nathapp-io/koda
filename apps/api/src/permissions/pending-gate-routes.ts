/** Routes whose approval gates are assigned to a later permissions rollout feature. */
export type PendingGateFeature = 'gate-high' | 'gate-secret' | 'gate-core-domains' | 'gate-fleet';

/** Explicitly identified secret-bearing routes remain outside the high-risk rollout. */
export const SECRET_GATE_ROUTES: ReadonlySet<string> = new Set([
  'POST /fleet/enrollments',
  'POST /projects/:slug/vcs',
  'PATCH /projects/:slug/vcs',
  'POST /projects/:slug/vcs/webhook-secret/rotate',
  'POST /projects/:slug/webhooks',
  'PATCH /projects/:slug/webhooks/:id',
]);

const ROUTE_ASSIGNMENTS = `
DELETE /comments/:id=gate-high
DELETE /projects/:slug/invites/:id=gate-core-domains
DELETE /projects/:slug/kb/documents/:sourceId=gate-high
DELETE /projects/:slug/labels/:id=gate-high
DELETE /projects/:slug/skills/:skillId=gate-core-domains
DELETE /projects/:slug/tickets/:ref=gate-high
DELETE /projects/:slug/tickets/:ref/fleet-jobs/:jobId=gate-fleet
DELETE /projects/:slug/tickets/:ref/labels/:labelId=gate-high
DELETE /projects/:slug/tickets/:ref/links/:linkId=gate-high
DELETE /projects/:slug/tickets/:ref/watch=gate-core-domains
DELETE /projects/:slug/vcs=gate-high
DELETE /projects/:slug/webhooks/:id=gate-high
DELETE /webhooks/:id=gate-high
PATCH /admin/users/:id=gate-core-domains
PATCH /agents/:slug=gate-core-domains
PATCH /agents/:slug/update-capabilities=gate-core-domains
PATCH /comments/:id=gate-core-domains
PATCH /projects/:slug=gate-core-domains
PATCH /projects/:slug/agents/:agentSlug=gate-core-domains
PATCH /projects/:slug/fleet/schedules/:id=gate-fleet
PATCH /projects/:slug/labels/:id=gate-core-domains
PATCH /projects/:slug/threads/:id=gate-fleet
PATCH /projects/:slug/tickets/:ref=gate-core-domains
PATCH /projects/:slug/vcs=gate-secret
PATCH /projects/:slug/webhooks/:id=gate-secret
PATCH /threads/:id=gate-fleet
POST /admin/outbox/:eventId/retry=gate-core-domains
POST /admin/skills/sources=gate-core-domains
POST /admin/skills/sources/:id/update=gate-core-domains
POST /admin/users=gate-core-domains
POST /agents=gate-core-domains
POST /agents/:slug/rotate-key=gate-core-domains
POST /code-intel/index=gate-core-domains
POST /context/:slug/query=gate-core-domains
POST /fleet/enrollments=gate-secret
POST /fleet/ingest/backfill=gate-fleet
POST /fleet/ingest/jobs/:jobId/rerun=gate-fleet
POST /fleet/ingest/rerun-outdated=gate-fleet
POST /fleet/test-hooks/schedules/:id/fire=gate-fleet
POST /memory=gate-core-domains
POST /memory/decisions=gate-core-domains
POST /memory/extract=gate-core-domains
POST /projects=gate-core-domains
POST /projects/:slug/fleet/approvals/:id/decide=gate-fleet
POST /projects/:slug/fleet/jobs=gate-fleet
POST /projects/:slug/fleet/jobs/:id/cancel=gate-fleet
POST /projects/:slug/fleet/jobs/:id/requeue=gate-fleet
POST /projects/:slug/fleet/repos/:repoId/config-edits=gate-fleet
POST /projects/:slug/fleet/repos/:repoId/config-edits/regenerate=gate-fleet
POST /projects/:slug/fleet/schedules=gate-fleet
POST /projects/:slug/fleet/schedules/:id/disable=gate-fleet
POST /projects/:slug/fleet/schedules/:id/enable=gate-fleet
POST /projects/:slug/invites=gate-core-domains
POST /projects/:slug/invites/:id/resend=gate-core-domains
POST /projects/:slug/kb/documents=gate-core-domains
POST /projects/:slug/kb/evaluate/retrieval=gate-core-domains
POST /projects/:slug/kb/import/graphify=gate-core-domains
POST /projects/:slug/kb/optimize=gate-core-domains
POST /projects/:slug/kb/search=gate-core-domains
POST /projects/:slug/knowledge/repos/:repoId/reindex=gate-fleet
POST /projects/:slug/labels=gate-core-domains
POST /projects/:slug/members=gate-core-domains
POST /projects/:slug/threads=gate-fleet
POST /projects/:slug/threads/:id/answer=gate-fleet
POST /projects/:slug/threads/:id/archive=gate-fleet
POST /projects/:slug/threads/:id/discard=gate-fleet
POST /projects/:slug/threads/:id/end-session=gate-fleet
POST /projects/:slug/threads/:id/messages=gate-fleet
POST /projects/:slug/threads/:id/plan=gate-fleet
POST /projects/:slug/threads/:id/publish=gate-fleet
POST /projects/:slug/threads/:id/run=gate-fleet
POST /projects/:slug/threads/:id/stop=gate-fleet
POST /projects/:slug/tickets=gate-core-domains
POST /projects/:slug/tickets/:ref/assign=gate-core-domains
POST /projects/:slug/tickets/:ref/close=gate-core-domains
POST /projects/:slug/tickets/:ref/comments=gate-core-domains
POST /projects/:slug/tickets/:ref/fix=gate-core-domains
POST /projects/:slug/tickets/:ref/labels=gate-core-domains
POST /projects/:slug/tickets/:ref/links=gate-core-domains
POST /projects/:slug/tickets/:ref/reject=gate-core-domains
POST /projects/:slug/tickets/:ref/start=gate-core-domains
POST /projects/:slug/tickets/:ref/verify=gate-core-domains
POST /projects/:slug/tickets/:ref/verify-fix=gate-core-domains
POST /projects/:slug/vcs=gate-secret
POST /projects/:slug/vcs/sync=gate-core-domains
POST /projects/:slug/vcs/sync-pr=gate-core-domains
POST /projects/:slug/vcs/sync/:issueNumber=gate-core-domains
POST /projects/:slug/vcs/test=gate-high
POST /projects/:slug/vcs/webhook-secret/rotate=gate-secret
POST /projects/:slug/webhooks=gate-secret
POST /threads=gate-fleet
POST /threads/:id/answer=gate-fleet
POST /threads/:id/archive=gate-fleet
POST /threads/:id/end-session=gate-fleet
POST /threads/:id/messages=gate-fleet
POST /threads/:id/stop=gate-fleet
PUT /fleet/test-hooks/repos/:repoId/nax-files=gate-fleet
PUT /projects/:slug/knowledge/patterns=gate-fleet
PUT /projects/:slug/skills/:skillId=gate-core-domains
PUT /projects/:slug/tickets/:ref/watch=gate-core-domains
`;

function isPendingGateFeature(value: string): value is PendingGateFeature {
  return value === 'gate-high' || value === 'gate-secret' || value === 'gate-core-domains' || value === 'gate-fleet';
}

export const PENDING_GATE_ROUTES: ReadonlyMap<string, PendingGateFeature> = new Map(
  ROUTE_ASSIGNMENTS.trim().split('\n').map((line) => {
    const separator = line.lastIndexOf('=');
    const feature = line.slice(separator + 1);
    if (separator < 0 || !isPendingGateFeature(feature)) {
      throw new Error(`invalid pending gate route assignment: ${line}`);
    }
    return [line.slice(0, separator), feature] as const;
  }),
);
