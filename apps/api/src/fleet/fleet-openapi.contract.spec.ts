import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Fleet slice 4a contract (overview D116-D120): the committed openapi.json must carry what the CLI
 * and web build on. Regenerate with `bun run api:export-spec` from the repo root.
 */
interface Operation { parameters?: Array<{ name: string; in: string; required?: boolean }> }
interface Spec {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, { properties?: Record<string, unknown>; required?: string[] }> };
}

const spec = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', '..', 'openapi.json'), 'utf-8')) as Spec;

describe('fleet OpenAPI contract', () => {
  it('exposes the job post-run stages (S2b (j) D433, D435; US-003 workflowStep)', () => {
    expect(Object.keys(spec.components.schemas['FleetJobDto']?.properties ?? {})).toContain('postRun');
    expect(Object.keys(spec.components.schemas['FleetJobPostRunDto']?.properties ?? {}).sort())
      .toEqual(['acceptance', 'finish', 'regression', 'workflowStep']);
  });

  it('declares the slug path param on every project-scoped fleet operation (D120)', () => {
    const scoped = Object.entries(spec.paths).filter(([path]) => path.startsWith('/api/projects/{slug}/fleet'));
    expect(scoped.length).toBeGreaterThanOrEqual(7);
    for (const [path, methods] of scoped) {
      for (const [method, op] of Object.entries(methods)) {
        const slug = (op.parameters ?? []).find((p) => p.name === 'slug' && p.in === 'path');
        expect({ path, method, slug: Boolean(slug?.required) }).toEqual({ path, method, slug: true });
      }
    }
  });

  it('exposes the runner boot fields and online state (#158, D116, D117)', () => {
    expect(Object.keys(spec.components.schemas['RunnerDto']?.properties ?? {})).toEqual(expect.arrayContaining(['bootId', 'bootedAt', 'online']));
  });

  it('US-001 AC-11: the ThreadDto kind enum carries the WORKSPACE kind', () => {
    const kind = spec.components.schemas['ThreadDto']?.properties?.['kind'] as { enum?: string[] } | undefined;
    expect(kind?.enum).toContain('WORKSPACE');
    expect(Object.keys(spec.components.schemas['ThreadDto']?.properties ?? {})).toContain('projectId');
  });

  it('exposes the project runner summaries and the repo check (D118, D119)', () => {
    expect(spec.paths['/api/projects/{slug}/fleet/runners']?.['get']).toBeDefined();
    expect(spec.paths['/api/fleet/repos/{id}/check']?.['post']).toBeDefined();
    expect(Object.keys(spec.components.schemas['RunnerSummaryDto']?.properties ?? {}).sort())
      .toEqual(['arch', 'enabled', 'id', 'labels', 'name', 'online', 'os', 'profiles', 'projectThreads', 'threadBackends', 'workspaceThreads']);
    expect(Object.keys(spec.components.schemas['RepoCheckResultDto']?.properties ?? {}).sort())
      .toEqual(['checkedAt', 'reachable', 'reason', 'repoId']);
  });

  it('exposes the thread run route and its body (US-007)', () => {
    expect(spec.paths['/api/projects/{slug}/threads/{id}/run']?.['post']).toBeDefined();
    const schemas = spec.components.schemas as Record<string, unknown>;
    expect(JSON.stringify(schemas['RunThreadDto'])).toContain('escalate');
  });

  it('exposes the web-facing thread facts: detail refusal and the list kill-switch flag (US-001)', () => {
    expect(Object.keys(spec.components.schemas['ThreadDetailDto']?.properties ?? {})).toContain('sendRefusal');
    expect(Object.keys(spec.components.schemas['ThreadDetailDto']?.properties ?? {})).toContain('handoff');
    expect(Object.keys(spec.components.schemas['ThreadListDto']?.properties ?? {})).toContain('threadsEnabled');
  });

  it('exposes the thread detail pending actions and their entry shape (S5b US-004, 2a-D12)', () => {
    expect(Object.keys(spec.components.schemas['ThreadDetailDto']?.properties ?? {})).toContain('pendingActions');
    expect(Object.keys(spec.components.schemas['PendingActionDto']?.properties ?? {}).sort())
      .toEqual(['approvalId', 'createdAt', 'expiresAt', 'id', 'preview', 'projectSlug', 'tool']);
    expect(JSON.stringify(spec.components.schemas['ThreadDetailDto']?.properties?.['pendingActions']))
      .toContain('#/components/schemas/PendingActionDto');
  });

  it('exposes the budget routes on both prefixes and the budget_paused misfit (S1b §2.3, §2.4)', () => {
    for (const base of ['/api/fleet/budgets', '/api/projects/{slug}/fleet/budgets']) {
      expect(spec.paths[base]?.['get']).toBeDefined();
      expect(spec.paths[base]?.['post']).toBeDefined();
      expect(spec.paths[`${base}/{id}`]?.['patch']).toBeDefined();
      expect(spec.paths[`${base}/{id}`]?.['delete']).toBeDefined();
      expect(spec.paths[`${base}/{id}/resume`]?.['post']).toBeDefined();
    }
    expect(Object.keys(spec.components.schemas['BudgetPolicyDto']?.properties ?? {}))
      .toEqual(expect.arrayContaining(['scopeType', 'windowKind', 'amountUsd', 'spentUsd', 'windowStart', 'paused', 'warnReached']));
    expect(JSON.stringify(spec.components.schemas['PlacementMisfitDto'])).toContain('budget_paused');
  });

  it('exposes the project_threads misfit on the dispatch and dashboard enums (US-005)', () => {
    expect(JSON.stringify(spec.components.schemas['PlacementMisfitDto'])).toContain('project_threads');
    expect(JSON.stringify(spec.components.schemas['AttentionReasonDto'])).toContain('project_threads');
  });

  it('exposes the schedule routes, the job schedule filter and the job schedule fields (S1b §3.4)', () => {
    const base = '/api/projects/{slug}/fleet/schedules';
    expect(spec.paths[base]?.['get']).toBeDefined();
    expect(spec.paths[base]?.['post']).toBeDefined();
    expect(spec.paths[`${base}/{id}`]?.['get']).toBeDefined();
    expect(spec.paths[`${base}/{id}`]?.['patch']).toBeDefined();
    expect(spec.paths[`${base}/{id}`]?.['delete']).toBeDefined();
    expect(spec.paths[`${base}/{id}/enable`]?.['post']).toBeDefined();
    expect(spec.paths[`${base}/{id}/disable`]?.['post']).toBeDefined();
    expect(Object.keys(spec.components.schemas['ScheduleDto']?.properties ?? {}))
      .toEqual(expect.arrayContaining(['cron', 'timezone', 'feature', 'enabled', 'nextFireAt', 'disabledReason', 'noProgressTicks', 'lastPassedCount', 'totalCostUsd']));
    expect(Object.keys(spec.components.schemas['FleetJobDto']?.properties ?? {})).toEqual(expect.arrayContaining(['scheduleId', 'coalescedCount']));
    const listParams = spec.paths['/api/projects/{slug}/fleet/jobs']?.['get']?.parameters ?? [];
    expect(listParams.map((p) => p.name)).toContain('scheduleId');
  });

  it('keeps the test-only hooks out of the contract (3b D213)', () => {
    expect(Object.keys(spec.paths).filter((path) => path.includes('test-hooks'))).toEqual([]);
  });

  it('exposes the approval routes, the counts route and the approval schemas (S1.5 §2.3)', () => {
    for (const base of ['/api/fleet/approvals', '/api/projects/{slug}/fleet/approvals']) {
      expect(spec.paths[base]?.['get']).toBeDefined();
      expect(spec.paths[`${base}/{id}`]?.['get']).toBeDefined();
      expect(spec.paths[`${base}/{id}/decide`]?.['post']).toBeDefined();
    }
    expect(spec.paths['/api/fleet/approval-counts']?.['get']).toBeDefined();
    expect(Object.keys(spec.components.schemas['FleetApprovalDto']?.properties ?? {}))
      .toEqual(expect.arrayContaining(['type', 'status', 'payload', 'outcome', 'decision', 'resolvedBy', 'requeueCandidates']));
    expect(Object.keys(spec.components.schemas['DecideApprovalDto']?.properties ?? {}).sort())
      .toEqual(['amountUsd', 'comment', 'decision', 'requeueJobIds']);
    expect(Object.keys(spec.components.schemas['ApprovalCountsDto']?.properties ?? {}).sort()).toEqual(['projects', 'total', 'unscoped']);
  });

  it('exposes the log read routes and their schemas (S2a §3)', () => {
    const base = '/api/projects/{slug}/fleet/jobs/{id}/logs';
    expect(spec.paths[base]?.['get']).toBeDefined();
    expect(spec.paths[`${base}/{stream}/entries`]?.['get']).toBeDefined();
    expect(spec.paths[`${base}/{stream}/raw`]?.['get']).toBeDefined();
    expect((spec.paths[`${base}/{stream}/entries`]?.['get']?.parameters ?? []).map((p) => p.name))
      .toEqual(expect.arrayContaining(['slug', 'id', 'stream', 'leaseEpoch', 'cursor', 'direction', 'limit', 'level', 'storyId', 'stage', 'role', 'q']));
    expect(Object.keys(spec.components.schemas['FleetJobLogEntriesDto']?.properties ?? {}).sort())
      .toEqual(['atEnd', 'complete', 'entries', 'nextCursor', 'scannedFrom', 'scannedTo', 'size', 'truncated']);
    expect(Object.keys(spec.components.schemas['FleetJobLogStreamDto']?.properties ?? {}))
      .toEqual(expect.arrayContaining(['stream', 'sizeBytes', 'complete', 'truncated', 'source', 'expired', 'updatedAt']));
  });

  it('exposes the analytics routes and their response shapes (S2b §4, D377, D382, D383)', () => {
    for (const route of ['spend', 'quality', 'stories', 'jobs', 'ingest']) {
      expect(spec.paths[`/api/projects/{slug}/fleet/analytics/${route}`]?.['get']).toBeDefined();
    }
    expect(spec.paths['/api/projects/{slug}/fleet/jobs/{id}/analytics']?.['get']).toBeDefined();
    expect(spec.paths['/api/fleet/analytics/spend']?.['get']).toBeDefined();
    expect(spec.paths['/api/fleet/analytics']?.['delete']).toBeDefined();
    const props = (name: string) => Object.keys(spec.components.schemas[name]?.properties ?? {}).sort();
    expect(props('SpendAnalyticsDto')).toEqual(['bucket', 'groupBy', 'series', 'totals', 'window']);
    expect(props('SpendSeriesDto')).toEqual(['costUsd', 'folded', 'key', 'label', 'points', 'tokens']);
    expect(props('StoriesAnalyticsDto')).toEqual(['rows', 'window']);
    expect(props('JobAnalyticsRowDto')).toEqual(['command', 'costUsd', 'driftUsd', 'featureName', 'finishedAt', 'jobId', 'ledgerCostUsd', 'state']);
    expect(props('JobAnalyticsDto')).toEqual(['byModel', 'byRole', 'byStage', 'corrected', 'ingest', 'jobId', 'ledgerCostUsd', 'liveCostUsd', 'reviews', 'stories']);
    expect(props('SpendTotalsDto')).toEqual(['cacheShare', 'costUsd', 'jobs', 'medianJobCostUsd', 'tokens']);
    expect(props('IngestHealthDto')).toEqual(['failed', 'pending', 'window']);
    const spendParams = (path: string) => (spec.paths[path]?.['get']?.parameters ?? []).map((p) => p.name);
    expect(spendParams('/api/projects/{slug}/fleet/analytics/spend')).toContain('top');
    expect(spendParams('/api/fleet/analytics/spend')).toContain('top');
  });

  it('exposes the dashboard routes and schemas (S2b (c) §1-§2)', () => {
    expect(spec.paths['/api/fleet/dashboard']?.['get']).toBeDefined();
    expect(spec.paths['/api/projects/{slug}/fleet/dashboard']?.['get']).toBeDefined();
    expect(Object.keys(spec.components.schemas['FleetDashboardDto']?.properties ?? {}).sort())
      .toEqual(['activeJobs', 'activeTruncated', 'attention', 'counts', 'generatedAt', 'recentJobs', 'recentTruncated', 'runners']);
    expect(Object.keys(spec.components.schemas['AttentionItemDto']?.properties ?? {}))
      .toEqual(expect.arrayContaining(['key', 'kind', 'severity', 'subjectType', 'since', 'stage', 'verdict', 'reasons', 'reasonsTotal', 'conditions']));
    expect(JSON.stringify(spec.components.schemas['AttentionItemDto'])).toContain('fits_not_placed');
    expect(Object.keys(spec.components.schemas['RunnerConditionDto']?.properties ?? {}))
      .toEqual(expect.arrayContaining(['type', 'jobsHeld', 'providerId', 'why', 'version', 'latest']));
    expect(spec.components.schemas['AttentionReasonDto']).toBeDefined();
  });

  it('documents the permission key and the 403 of every project fleet read (P1d US-004)', () => {
    // The committed spec is the CLI's and web's contract, so a migrated route must read as one that
    // needs its catalog key — a stale openapi.json still advertises "project member" (R10) and no 403.
    const routes: Array<[string, string, string]> = [
      ['/api/projects/{slug}/fleet/jobs/{id}/logs', 'get', 'fleet.job.logs.read'],
      ['/api/projects/{slug}/fleet/jobs/{id}/logs/{stream}/entries', 'get', 'fleet.job.logs.read'],
      ['/api/projects/{slug}/fleet/jobs/{id}/logs/{stream}/raw', 'get', 'fleet.job.logs.read'],
      ['/api/projects/{slug}/fleet/jobs/{id}/bundle', 'get', 'fleet.job.bundle.read'],
      ['/api/projects/{slug}/fleet/analytics/spend', 'get', 'fleet.analytics.read'],
      ['/api/projects/{slug}/fleet/analytics/quality', 'get', 'fleet.analytics.read'],
      ['/api/projects/{slug}/fleet/analytics/stories', 'get', 'fleet.analytics.read'],
      ['/api/projects/{slug}/fleet/analytics/jobs', 'get', 'fleet.analytics.read'],
      ['/api/projects/{slug}/fleet/analytics/ingest', 'get', 'fleet.analytics.read'],
      ['/api/projects/{slug}/fleet/jobs/{id}/analytics', 'get', 'fleet.analytics.read'],
      ['/api/projects/{slug}/fleet/dashboard', 'get', 'fleet.dashboard.read'],
      ['/api/projects/{slug}/fleet/runners', 'get', 'fleet.runner.read'],
      ['/api/projects/{slug}/fleet/repos', 'get', 'fleet.repo.read'],
    ];
    const documented = routes.map(([path, method, key]) => {
      const op = (spec.paths[path]?.[method] ?? {}) as {
        summary?: string;
        responses?: Record<string, unknown>;
      };
      return { path, key, summary: op.summary ?? null, forbidden: op.responses?.['403'] !== undefined };
    });
    expect(documented).toEqual(
      routes.map(([path, , key]) => ({ path, key, summary: expect.stringContaining(`(${key}`), forbidden: true })),
    );
  });

  it('documents the permission key and the 403 of every global fleet admin route (P1d US-008)', () => {
    // The global counterpart of the US-004 case above: every route this story migrated names its
    // catalog key in its summary and documents the refusal, so the committed spec keeps saying the
    // key decides instead of the legacy "global admin" gate.
    const routes: Array<[string, string, string]> = [
      ['/api/fleet/analytics/spend', 'get', 'fleet.analytics.read'],
      ['/api/fleet/analytics', 'delete', 'fleet.analytics.delete'],
      ['/api/fleet/dashboard', 'get', 'fleet.dashboard.read'],
      ['/api/fleet/credential-board', 'get', 'fleet.credential.read'],
      ['/api/fleet/ingest', 'get', 'fleet.ingest.read'],
      ['/api/fleet/ingest/backfill', 'post', 'fleet.ingest.backfill'],
      ['/api/fleet/ingest/jobs/{jobId}/rerun', 'post', 'fleet.ingest.rerun'],
      ['/api/fleet/ingest/rerun-outdated', 'post', 'fleet.ingest.rerun'],
      ['/api/fleet/repos', 'get', 'fleet.repo.read'],
      ['/api/fleet/repos', 'post', 'fleet.repo.create'],
      ['/api/fleet/repos/{id}/check', 'post', 'fleet.repo.check'],
      ['/api/fleet/repos/{id}', 'delete', 'fleet.repo.delete'],
      ['/api/fleet/enrollments', 'get', 'fleet.enrollment.read'],
      ['/api/fleet/enrollments', 'post', 'fleet.enrollment.create'],
      ['/api/fleet/runners', 'get', 'fleet.runner.read'],
      ['/api/fleet/runners/{id}', 'get', 'fleet.runner.read'],
      ['/api/fleet/runners/{id}', 'patch', 'fleet.runner.update'],
      ['/api/fleet/runners/{id}', 'delete', 'fleet.runner.delete'],
    ];
    const documented = routes.map(([path, method, key]) => {
      const op = (spec.paths[path]?.[method] ?? {}) as {
        summary?: string;
        responses?: Record<string, unknown>;
      };
      return { path, method, key, summary: op.summary ?? null, forbidden: op.responses?.['403'] !== undefined };
    });
    expect(documented).toEqual(
      routes.map(([path, method, key]) => ({ path, method, key, summary: expect.stringContaining(`(${key}`), forbidden: true })),
    );
    // The activity feed answers its key in the handler (`projectIdsWithKey`), so its own 403 is gone:
    // the route cannot refuse a caller, it filters the rows for them.
    const activity = spec.paths['/api/fleet/activity']?.['get'] as { summary?: string; responses?: Record<string, unknown> } | undefined;
    expect(activity?.summary).toContain('fleet.activity.read');
    expect(activity?.responses?.['403']).toBeUndefined();
  });

  it('exposes the credential board (S3 §4.4)', () => {
    expect(spec.paths['/api/fleet/credential-board']?.['get']).toBeDefined();
    expect(Object.keys(spec.components.schemas['CredentialBoardDto']?.properties ?? {}).sort())
      .toEqual(['generatedAt', 'profiles', 'providers', 'runners', 'warnDays']);
    expect(JSON.stringify(spec.components.schemas['CredentialCellDto'])).toContain('expiring');
    expect(JSON.stringify(spec.components.schemas['RunnerConditionDto'])).toContain('expiring');
  });
});


it('workspace AC-5 exposes workspace_threads in placement, attention and credential board', () => {
  expect(JSON.stringify(spec.components.schemas['PlacementMisfitDto'])).toContain('workspace_threads');
  expect(JSON.stringify(spec.components.schemas['AttentionReasonDto'])).toContain('workspace_threads');
  expect(JSON.stringify(spec.components.schemas['ProfileCellDto'])).toContain('workspace_threads');
});
