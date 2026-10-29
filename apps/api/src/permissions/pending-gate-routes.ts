/** Routes whose approval gates are assigned to a later permissions rollout feature. */
export type PendingGateFeature = 'gate-secret' | 'gate-fleet';

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
PATCH /projects/:slug/vcs=gate-secret
PATCH /projects/:slug/webhooks/:id=gate-secret
PATCH /threads/:id=gate-fleet
POST /admin/users=gate-secret
POST /agents=gate-secret
POST /agents/:slug/rotate-key=gate-secret
POST /fleet/enrollments=gate-secret
POST /projects/:slug/invites=gate-secret
POST /projects/:slug/invites/:id/resend=gate-secret
POST /projects/:slug/threads/:id/messages=gate-fleet
POST /projects/:slug/vcs=gate-secret
POST /projects/:slug/vcs/webhook-secret/rotate=gate-secret
POST /projects/:slug/webhooks=gate-secret
POST /threads=gate-fleet
POST /threads/:id/answer=gate-fleet
POST /threads/:id/archive=gate-fleet
POST /threads/:id/end-session=gate-fleet
POST /threads/:id/messages=gate-fleet
POST /threads/:id/stop=gate-fleet
`;

function isPendingGateFeature(value: string): value is PendingGateFeature {
  return value === 'gate-secret' || value === 'gate-fleet';
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
