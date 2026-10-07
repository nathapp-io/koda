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
  it('exposes the job post-run stages (S2b (j) D433, D435)', () => {
    expect(Object.keys(spec.components.schemas['FleetJobDto']?.properties ?? {})).toContain('postRun');
    expect(Object.keys(spec.components.schemas['FleetJobPostRunDto']?.properties ?? {}).sort()).toEqual(['acceptance', 'finish', 'regression']);
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

  it('exposes project runner summaries and the repo check (D118, D119)', () => {
    expect(spec.paths['/api/projects/{slug}/fleet/runners']?.['get']).toBeDefined();
    expect(spec.paths['/api/fleet/repos/{id}/check']?.['post']).toBeDefined();
    expect(Object.keys(spec.components.schemas['RunnerSummaryDto']?.properties ?? {}).sort())
      .toEqual(['arch', 'enabled', 'id', 'labels', 'name', 'online', 'os', 'profiles']);
    expect(Object.keys(spec.components.schemas['RepoCheckResultDto']?.properties ?? {}).sort())
      .toEqual(['checkedAt', 'reachable', 'reason', 'repoId']);
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

  it('exposes the credential board (S3 §4.4)', () => {
    expect(spec.paths['/api/fleet/credential-board']?.['get']).toBeDefined();
    expect(Object.keys(spec.components.schemas['CredentialBoardDto']?.properties ?? {}).sort())
      .toEqual(['generatedAt', 'profiles', 'providers', 'runners', 'warnDays']);
    expect(JSON.stringify(spec.components.schemas['CredentialCellDto'])).toContain('expiring');
    expect(JSON.stringify(spec.components.schemas['RunnerConditionDto'])).toContain('expiring');
  });
});
