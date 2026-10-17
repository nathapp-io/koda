import { actionRequestedDraft, approvalDrafts, budgetDrafts, healthDrafts, jobOutcomeDraft } from './fleet-notification-drafts';

describe('fleet notification drafts (S4a contract: kinds, links, params)', () => {
  const outcome = { jobId: 'j1', leaseEpoch: 2, projectId: 'p1', requestedById: 'u1', outcome: 'escalated' as const, repo: 'acme/app', feature: 'add', resultPrUrl: null };

  it('job escalation -> requester, FLEET_NEEDS_YOU, job page, keyed per attempt', () => {
    expect(jobOutcomeDraft(outcome, 'web')).toEqual({
      userId: 'u1', projectId: 'p1', category: 'FLEET_NEEDS_YOU', kind: 'job_escalated',
      title: 'Fleet job on acme/app escalated', body: null, link: '/web/fleet/jobs/j1',
      params: { repo: 'acme/app', feature: 'add', state: 'escalated' }, sourceType: 'fleet_job', sourceId: 'j1:2', actorId: null,
    });
  });

  it('job with a PR -> job_pr_opened with the PR url', () => {
    const d = jobOutcomeDraft({ ...outcome, outcome: 'pr_opened', resultPrUrl: 'https://github.com/acme/app/pull/7' }, 'web');
    expect(d).toMatchObject({ kind: 'job_pr_opened', title: 'Fleet job on acme/app opened a PR', params: { repo: 'acme/app', feature: 'add', prUrl: 'https://github.com/acme/app/pull/7' } });
  });

  it('truncates a title built from a very long repo name', () => {
    const d = jobOutcomeDraft({ ...outcome, repo: `acme/${'x'.repeat(400)}` }, 'web');
    expect(d.title.length).toBeLessThanOrEqual(200);
    expect(d.title.endsWith('…')).toBe(true);
  });

  it('approval ask -> one draft per admin', () => {
    const ds = approvalDrafts(['a1', 'a2'], { approvalId: 'ap1', projectId: 'p1', kindLabel: 'bash', repo: 'acme/app' });
    expect(ds.map((d) => d.userId)).toEqual(['a1', 'a2']);
    expect(ds[0]).toEqual({
      userId: 'a1', projectId: 'p1', category: 'FLEET_NEEDS_YOU', kind: 'approval_requested', title: 'Approval needed: bash on acme/app',
      body: null, link: '/admin/fleet/approvals', params: { repo: 'acme/app', kind: 'bash' }, sourceType: 'fleet_approval', sourceId: 'ap1', actorId: null,
    });
  });

  it('action ask (S5b 2a-D6) -> one draft for the requester, linked to the thread path', () => {
    expect(actionRequestedDraft({ approvalId: 'ap1', projectId: 'p1', requestedById: 'u1', threadPath: '/web/threads/t1', tool: 'koda_add_comment' })).toEqual({
      userId: 'u1', projectId: 'p1', category: 'FLEET_NEEDS_YOU', kind: 'action_requested',
      title: 'Approval needed: koda_add_comment in a thread', body: null, link: '/web/threads/t1',
      params: { tool: 'koda_add_comment' }, sourceType: 'fleet_approval', sourceId: 'ap1', actorId: null,
    });
  });

  it('action ask of a WORKSPACE thread keeps the projectless-looking link it was given', () => {
    expect(actionRequestedDraft({ approvalId: 'ap2', projectId: 'p1', requestedById: 'u2', threadPath: '/threads/t2', tool: 'koda_get_action' }))
      .toMatchObject({ userId: 'u2', link: '/threads/t2', params: { tool: 'koda_get_action' }, sourceId: 'ap2' });
  });

  it('action ask with a very long tool name is truncated like every other title', () => {
    const d = actionRequestedDraft({ approvalId: 'ap3', projectId: null, requestedById: 'u1', threadPath: '/web/threads/t1', tool: `koda_${'x'.repeat(400)}` });
    expect(d.title.length).toBeLessThanOrEqual(200);
    expect(d.title.endsWith('…')).toBe(true);
  });

  it('budget incidents -> FLEET_HEALTH for admins, money shown with 2 decimals', () => {
    const [d] = budgetDrafts(['a1'], { incidentId: 'i1', kind: 'hard_stop', scope: 'project KODA', spentUsd: '12.3456', amountUsd: '10' });
    expect(d).toEqual({
      userId: 'a1', projectId: null, category: 'FLEET_HEALTH', kind: 'budget_hard_stop', title: 'Budget project KODA: $12.35 of $10.00',
      body: null, link: '/admin/fleet/budgets', params: { scope: 'project KODA', spentUsd: '12.35', amountUsd: '10.00' },
      sourceType: 'fleet_budget_incident', sourceId: 'i1', actorId: null,
    });
    expect(budgetDrafts(['a1'], { incidentId: 'i2', kind: 'warn', scope: 'global', spentUsd: '5', amountUsd: '10' })[0].kind).toBe('budget_warn');
  });

  it('health alerts -> runner_offline and credential_expiring', () => {
    const [off] = healthDrafts(['a1'], { alertId: 'al1', kind: 'runner_offline', runner: 'wk-mac', provider: null, expiresAt: null });
    expect(off).toMatchObject({ kind: 'runner_offline', category: 'FLEET_HEALTH', title: 'Runner wk-mac is offline', link: '/admin/fleet/runners', params: { runner: 'wk-mac' }, sourceType: 'fleet_health_alert', sourceId: 'al1', projectId: null });
    const [cred] = healthDrafts(['a1'], { alertId: 'al2', kind: 'credential_expiring', runner: 'wk-mac', provider: 'openai-codex', expiresAt: '2026-10-11T08:00:00.000Z' });
    expect(cred).toMatchObject({
      kind: 'credential_expiring', title: 'openai-codex credential on wk-mac expires 2026-10-11', link: '/admin/fleet/credentials',
      params: { runner: 'wk-mac', provider: 'openai-codex', expiresAt: '2026-10-11' },
    });
  });

  it('no admins -> no drafts', () => {
    expect(budgetDrafts([], { incidentId: 'i', kind: 'warn', scope: 'global', spentUsd: '1', amountUsd: '2' })).toEqual([]);
  });
});
