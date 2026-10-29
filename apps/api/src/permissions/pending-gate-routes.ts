/** Routes whose approval gates are assigned to a later permissions rollout feature. */
export type PendingGateFeature = 'gate-secret' | 'gate-core-domains' | 'gate-fleet';

/** Explicitly identified secret-bearing routes remain outside the high-risk rollout. */
export const SECRET_GATE_ROUTES: ReadonlySet<string> = new Set([
  'POST /fleet/enrollments',
  'POST /projects/:slug/vcs',
  'PATCH /projects/:slug/vcs',
  'POST /projects/:slug/vcs/webhook-secret/rotate',
  'POST /projects/:slug/webhooks',
  'PATCH /projects/:slug/webhooks/:id',
  'POST /projects/:slug/invites',
  'POST /projects/:slug/invites/:id/resend',
  'POST /agents',
  'POST /agents/:slug/rotate-key',
  'POST /admin/users',
]);

const ROUTE_ASSIGNMENTS = `
DELETE /projects/:slug/tickets/:ref/fleet-jobs/:jobId=gate-fleet
PATCH /projects/:slug/fleet/schedules/:id=gate-fleet
PATCH /projects/:slug/threads/:id=gate-fleet
PATCH /projects/:slug/vcs=gate-secret
PATCH /projects/:slug/webhooks/:id=gate-secret
PATCH /threads/:id=gate-fleet
POST /admin/skills/sources=gate-core-domains
POST /admin/skills/sources/:id/update=gate-core-domains
POST /admin/users=gate-secret
POST /agents=gate-secret
POST /agents/:slug/rotate-key=gate-secret
POST /fleet/enrollments=gate-secret
POST /fleet/ingest/backfill=gate-fleet
POST /fleet/ingest/jobs/:jobId/rerun=gate-fleet
POST /fleet/ingest/rerun-outdated=gate-fleet
POST /fleet/test-hooks/schedules/:id/fire=gate-fleet
POST /projects/:slug/fleet/approvals/:id/decide=gate-fleet
POST /projects/:slug/fleet/jobs=gate-fleet
POST /projects/:slug/fleet/jobs/:id/cancel=gate-fleet
POST /projects/:slug/fleet/jobs/:id/requeue=gate-fleet
POST /projects/:slug/fleet/repos/:repoId/config-edits=gate-fleet
POST /projects/:slug/fleet/repos/:repoId/config-edits/regenerate=gate-fleet
POST /projects/:slug/fleet/schedules=gate-fleet
POST /projects/:slug/fleet/schedules/:id/disable=gate-fleet
POST /projects/:slug/fleet/schedules/:id/enable=gate-fleet
POST /projects/:slug/invites=gate-secret
POST /projects/:slug/invites/:id/resend=gate-secret
POST /projects/:slug/kb/documents=gate-core-domains
POST /projects/:slug/kb/import/graphify=gate-core-domains
POST /projects/:slug/kb/optimize=gate-core-domains
POST /projects/:slug/knowledge/repos/:repoId/reindex=gate-fleet
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
POST /projects/:slug/vcs=gate-secret
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
`;

function isPendingGateFeature(value: string): value is PendingGateFeature {
  return value === 'gate-secret' || value === 'gate-core-domains' || value === 'gate-fleet';
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
