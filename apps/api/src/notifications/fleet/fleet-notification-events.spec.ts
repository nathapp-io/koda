import {
  budgetIncidentId, budgetScopeLabel, buildJobOutcomePayload, jobOutcomeOf,
  parseApprovalRequestedPayload, parseBudgetIncidentPayload, parseHealthAlertPayload, parseJobOutcomePayload,
} from './fleet-notification-events';

describe('jobOutcomeOf (S4a §2.4)', () => {
  it.each([
    ['ESCALATED', null, 'escalated'],
    ['FAILED', null, 'failed'],
    ['CRASHED', null, 'crashed'],
    ['COMPLETED', 'https://github.com/acme/app/pull/3', 'pr_opened'],
    ['COMPLETED', null, null],
    ['CANCELLED', null, null],
    ['RUNNING', null, null],
  ] as const)('%s with pr %s -> %s', (state, pr, expected) => {
    expect(jobOutcomeOf(state, pr)).toBe(expected);
  });
});

describe('buildJobOutcomePayload', () => {
  it('carries the attempt epoch, requester and the PR url', () => {
    const job = { id: 'j1', leaseEpoch: 3, projectId: 'p1', requestedById: 'u1', feature: 'add', resultPrUrl: 'https://x/pull/1' };
    expect(buildJobOutcomePayload(job, 'acme/app', 'pr_opened')).toEqual({
      jobId: 'j1', leaseEpoch: 3, projectId: 'p1', requestedById: 'u1', outcome: 'pr_opened', repo: 'acme/app', feature: 'add',
      resultPrUrl: 'https://x/pull/1',
    });
  });
});

describe('budgetIncidentId', () => {
  it('is the incident dedupe key (policy, kind, window, amount)', () => {
    expect(budgetIncidentId('pol1', 'warn', new Date('2026-10-01T00:00:00.000Z'), '10'))
      .toBe('pol1:warn:2026-10-01T00:00:00.000Z:10');
  });
});

describe('budgetScopeLabel', () => {
  it.each([
    ['global', null, null, 'global'],
    ['project', 'p1', 'KODA', 'project KODA'],
    ['repo', 'r1', 'acme/app', 'acme/app'],
    ['runner', 'rn1', 'wk-mac', 'runner wk-mac'],
    ['repo', 'r9', null, 'repo r9'],
  ] as const)('%s %s (%s) -> %s', (type, id, name, expected) => {
    expect(budgetScopeLabel(type, id, name)).toBe(expected);
  });
});

describe('payload parsers', () => {
  const outcome = { jobId: 'j1', leaseEpoch: 1, projectId: 'p1', requestedById: 'u1', outcome: 'failed', repo: 'acme/app', feature: 'f', resultPrUrl: null };

  it('accepts a well-formed job outcome and rejects bad ones', () => {
    expect(parseJobOutcomePayload(outcome)).toEqual(outcome);
    expect(parseJobOutcomePayload({ ...outcome, outcome: 'cancelled' })).toBeNull();
    expect(parseJobOutcomePayload({ ...outcome, leaseEpoch: '1' })).toBeNull();
    expect(parseJobOutcomePayload({ ...outcome, requestedById: '' })).toBeNull();
    expect(parseJobOutcomePayload(null)).toBeNull();
    expect(parseJobOutcomePayload('x')).toBeNull();
  });

  it('accepts a budget incident and rejects an unknown kind', () => {
    const p = { incidentId: 'i', kind: 'hard_stop', scope: 'global', spentUsd: '12.5', amountUsd: '10' };
    expect(parseBudgetIncidentPayload(p)).toEqual(p);
    expect(parseBudgetIncidentPayload({ ...p, kind: 'resumed' })).toBeNull();
  });

  it('accepts a health alert with or without provider', () => {
    const offline = { alertId: 'a', kind: 'runner_offline', runner: 'wk-mac', provider: null, expiresAt: null };
    const cred = { alertId: 'b', kind: 'credential_expiring', runner: 'wk-mac', provider: 'openai-codex', expiresAt: '2026-10-11T00:00:00.000Z' };
    expect(parseHealthAlertPayload(offline)).toEqual(offline);
    expect(parseHealthAlertPayload(cred)).toEqual(cred);
    expect(parseHealthAlertPayload({ ...offline, kind: 'disk_full' })).toBeNull();
  });

  it('reads the #236 approval payload and ignores its other fields', () => {
    const raw = { approvalId: 'ap1', type: 'nax_bash_escalate', status: 'pending', decision: null, resolvedBy: null, projectId: 'p1', jobId: 'j1', policyId: null, expiresAt: null, path: '/web/fleet/approvals?id=ap1' };
    expect(parseApprovalRequestedPayload(raw)).toEqual({ approvalId: 'ap1', type: 'nax_bash_escalate', projectId: 'p1', jobId: 'j1', policyId: null });
    expect(parseApprovalRequestedPayload({ ...raw, approvalId: 7 })).toBeNull();
  });
});
