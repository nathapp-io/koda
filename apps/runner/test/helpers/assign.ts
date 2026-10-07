import { isConfigKind, type AssignPayload, type FleetJobKindName } from '@nathapp/fleet-protocol';

export function assignFor(command: FleetJobKindName = 'RUN', over: Partial<AssignPayload> = {}): AssignPayload {
  const config = isConfigKind(command);
  return {
    jobId: 'j1', command,
    repo: { provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', cloneUrl: 'https://github.com/acme/app.git' },
    ref: 'main', feature: config ? 'nax-config' : 'feat', planFrom: command === 'PLAN' ? 'docs/spec.md' : null, profiles: [],
    maxCostUsd: config ? '0' : '5', bashMode: 'raw', approvalTimeoutSec: 600,
    gitIdentity: { name: 'koda-fleet[bot]', email: 'koda-fleet[bot]@users.noreply.github.com' }, ...over,
  };
}
