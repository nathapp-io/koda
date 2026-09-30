import type { AssignPayload } from '@nathapp/fleet-protocol';

export function assignFor(command: 'RUN' | 'PLAN' = 'RUN', over: Partial<AssignPayload> = {}): AssignPayload {
  return {
    jobId: 'j1', command,
    repo: { provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', cloneUrl: 'https://github.com/acme/app.git' },
    ref: 'main', feature: 'feat', planFrom: command === 'PLAN' ? 'docs/spec.md' : null, profiles: [], maxCostUsd: '5', bashMode: 'raw',
    gitIdentity: { name: 'koda-fleet[bot]', email: 'koda-fleet[bot]@users.noreply.github.com' }, ...over,
  };
}
