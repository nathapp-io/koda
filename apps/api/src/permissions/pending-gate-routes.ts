/** Routes whose approval gates are assigned to a later permissions rollout feature. */
export type PendingGateFeature = 'gate-secret';

/** Explicitly identified secret-bearing routes remain outside the high-risk rollout. */
export const SECRET_GATE_ROUTES: ReadonlySet<string> = new Set([
  'POST /projects/:slug/vcs',
  'PATCH /projects/:slug/vcs',
  'POST /projects/:slug/vcs/webhook-secret/rotate',
  'POST /projects/:slug/webhooks',
  'PATCH /projects/:slug/webhooks/:id',
  'POST /projects/:slug/invites',
  'POST /projects/:slug/invites/:id/resend',
]);

const ROUTE_ASSIGNMENTS = `
PATCH /projects/:slug/vcs=gate-secret
PATCH /projects/:slug/webhooks/:id=gate-secret
POST /projects/:slug/invites=gate-secret
POST /projects/:slug/invites/:id/resend=gate-secret
POST /projects/:slug/vcs=gate-secret
POST /projects/:slug/vcs/webhook-secret/rotate=gate-secret
POST /projects/:slug/webhooks=gate-secret
`;

function isPendingGateFeature(value: string): value is PendingGateFeature {
  return value === 'gate-secret';
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
