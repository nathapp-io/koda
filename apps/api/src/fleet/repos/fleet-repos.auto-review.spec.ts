import { NotFoundAppException } from '@nathapp/nestjs-common';
import { validateSync } from 'class-validator';
import { AutoReviewException } from './auto-review.exception';
import { FleetReposService } from './fleet-repos.service';
import { UpdateAutoReviewDto } from './dto/update-auto-review.dto';

describe('FleetReposService.configureAutoReview', () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: 'r1', projectId: 'p1', provider: 'github', owner: 'acme', name: 'repo', defaultBranch: 'main',
    githubInstallationId: 1n, createdById: 'u0', createdAt: new Date(0), autoReview: false,
    autoReviewProfiles: ['stored'], autoReviewMaxCostUsd: '3.2500', autoReviewEnabledById: null,
    autoReviewEnabledByType: null, autoReviewEnabledAt: null, ...overrides,
  });
  let repo: { findById: ReturnType<typeof vi.fn>; updateAutoReview: ReturnType<typeof vi.fn> };
  let tx: { run: ReturnType<typeof vi.fn> };
  let audit: { record: ReturnType<typeof vi.fn> };
  let permissions: { canHoldKey: ReturnType<typeof vi.fn> };

  const service = () => new FleetReposService(
    repo as never, {} as never, {} as never, {} as never, {} as never, tx as never,
    audit as never, permissions as never,
  );
  const principal = (actorType: 'user' | 'agent' = 'user') => ({ actorType, id: actorType === 'user' ? 'u1' : 'a1' }) as never;
  const configure = (enabled: boolean, extra: Partial<UpdateAutoReviewDto> = {}, actorType: 'user' | 'agent' = 'user') =>
    service().configureAutoReview(principal(actorType), 'r1', { enabled, ...extra } as UpdateAutoReviewDto);

  beforeEach(() => {
    repo = { findById: vi.fn().mockResolvedValue(row()), updateAutoReview: vi.fn().mockImplementation(async (_id, patch) => row(patch)) };
    tx = { run: vi.fn((fn: () => Promise<unknown>) => fn()) };
    audit = { record: vi.fn() };
    permissions = { canHoldKey: vi.fn().mockResolvedValue(true) };
  });

  it('sets enabled settings and user attribution', async () => {
    await configure(true, { profiles: ['native-ds'], maxCostUsd: 2.5 });
    expect(repo.updateAutoReview).toHaveBeenCalledWith('r1', expect.objectContaining({ autoReview: true, autoReviewProfiles: ['native-ds'], autoReviewMaxCostUsd: expect.anything(), autoReviewEnabledById: 'u1', autoReviewEnabledByType: 'USER' }));
  });
  it('attributes agent callers', async () => { await configure(true, {}, 'agent'); expect(repo.updateAutoReview).toHaveBeenCalledWith('r1', expect.objectContaining({ autoReviewEnabledById: 'a1', autoReviewEnabledByType: 'AGENT' })); });
  it('sets activation time once and preserves it on re-save', async () => {
    await configure(true); expect(repo.updateAutoReview.mock.calls[0][1].autoReviewEnabledAt).toBeInstanceOf(Date);
    const enabledAt = new Date('2026-11-01T00:00:00Z'); repo.findById.mockResolvedValue(row({ autoReview: true, autoReviewEnabledAt: enabledAt }));
    await configure(true); expect(repo.updateAutoReview.mock.calls[1][1].autoReviewEnabledAt).toBe(enabledAt);
  });
  it('keeps omitted fields when enabling', async () => { await configure(true); expect(repo.updateAutoReview).toHaveBeenCalledWith('r1', expect.not.objectContaining({ autoReviewProfiles: expect.anything(), autoReviewMaxCostUsd: expect.anything() })); });
  it('disables without changing stored profile/cost and clears attribution', async () => {
    await configure(false, { profiles: ['x'], maxCostUsd: 4 });
    expect(repo.updateAutoReview).toHaveBeenCalledWith('r1', expect.objectContaining({ autoReview: false, autoReviewEnabledById: null, autoReviewEnabledByType: null, autoReviewEnabledAt: null }));
    expect(repo.updateAutoReview.mock.calls[0][1]).not.toHaveProperty('autoReviewProfiles');
  });
  it.each([{ provider: 'gitlab' }, { githubInstallationId: null }])('requires an installed GitHub app: %o', async (overrides) => {
    repo.findById.mockResolvedValue(row(overrides)); await expect(configure(true)).rejects.toMatchObject({ reason: 'github app required', status: 422 });
  });
  it('rejects reserved or invalid profiles and duplicates', async () => {
    await expect(configure(true, { profiles: ['koda-job-x'] })).rejects.toMatchObject({ reason: 'profiles' });
    await expect(configure(true, { profiles: ['a', 'a'] })).rejects.toMatchObject({ reason: 'duplicate profile' });
  });
  it.each(['user', 'agent'] as const)('requires dispatch permission for %s', async (actorType) => {
    permissions.canHoldKey.mockResolvedValue(false);
    await expect(configure(true, {}, actorType)).rejects.toMatchObject({ reason: 'caller cannot dispatch in this project' });
    expect(permissions.canHoldKey).toHaveBeenCalledWith({ type: actorType === 'user' ? 'USER' : 'AGENT', id: actorType === 'user' ? 'u1' : 'a1' }, 'fleet.job.dispatch', { projectId: 'p1' });
  });
  it('404s an unknown repo', async () => { repo.findById.mockResolvedValue(null); await expect(configure(true)).rejects.toBeInstanceOf(NotFoundAppException); });
  it('records audit in the transaction containing update', async () => {
    const events: string[] = [];
    tx.run.mockImplementation(async (fn) => { events.push('begin'); const value = await fn(); events.push('end'); return value; });
    repo.updateAutoReview.mockImplementation(async () => { events.push('update'); return row({ autoReview: true }); });
    audit.record.mockImplementation(async () => { events.push('audit'); });
    await configure(true);
    expect(events).toEqual(['begin', 'update', 'audit', 'end']);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ key: 'fleet.repo.review.configure', resourceId: 'r1' }));
  });
});

describe('UpdateAutoReviewDto validation', () => {
  const errors = (value: Partial<UpdateAutoReviewDto>) => validateSync(Object.assign(new UpdateAutoReviewDto(), { enabled: true, ...value }));
  it('accepts bounds and validates optional fields even when disabled', () => {
    expect(errors({ enabled: false, profiles: Array(8).fill('x'.repeat(64)), maxCostUsd: 10_000 })).toHaveLength(0);
    expect(errors({ enabled: false, profiles: Array(9).fill('x'), maxCostUsd: 1.00001 }).length).toBeGreaterThan(0);
    expect(errors({ enabled: true, maxCostUsd: 0.00001 }).length).toBeGreaterThan(0);
  });
});
