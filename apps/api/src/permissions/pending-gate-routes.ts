/** Empty rollout checkpoints retained until US-007 removes the temporary contract. */
export type PendingGateFeature = 'gate-secret';

export const SECRET_GATE_ROUTES: ReadonlySet<string> = new Set();
export const PENDING_GATE_ROUTES: ReadonlyMap<string, PendingGateFeature> = new Map();
