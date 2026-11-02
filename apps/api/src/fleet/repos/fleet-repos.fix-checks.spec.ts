import { NotFoundAppException } from '@nathapp/nestjs-common';
import { FixChecksException } from './fix-checks.exception';
import { FleetReposService } from './fleet-repos.service';
import type { UpdateFixChecksDto } from './dto/update-fix-checks.dto';

/**
 * Fleet FIX US-001: `configureFixChecks` writes one boolean column in a transaction and audits it.
 * The switch only affects what a FIX may run, so the only refusal is a repo koda cannot broker a
 * GitHub App token for; disabling is always allowed.
 */
describe('FleetReposService.configureFixChecks', () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: 'r1', projectId: 'p1', provider: 'github', owner: 'acme', name: 'repo', defaultBranch: 'main',
    githubInstallationId: 1n, createdById: 'u0', createdAt: new Date(0), autoReview: false,
    autoReviewProfiles: [], autoReviewMaxCostUsd: '1.0000', autoReviewEnabledById: null,
    autoReviewEnabledByType: null, autoReviewEnabledAt: null, fixTrustDetectedChecks: false, ...overrides,
  });
  let repo: { findById: ReturnType<typeof vi.fn>; updateFixChecks: ReturnType<typeof vi.fn> };
  let tx: { run: ReturnType<typeof vi.fn> };
  let audit: { record: ReturnType<typeof vi.fn> };
  let permissions: { canHoldKey: ReturnType<typeof vi.fn> };

  const service = () => new FleetReposService(
    repo as never, {} as never, {} as never, {} as never, {} as never, tx as never,
    audit as never, permissions as never,
  );
  const principal = (actorType: 'user' | 'agent' = 'user') =>
    ({ actorType, id: actorType === 'user' ? 'u1' : 'a1' }) as never;
  const configure = (trustDetectedChecks: boolean, actorType: 'user' | 'agent' = 'user') =>
    service().configureFixChecks(principal(actorType), 'r1', { trustDetectedChecks } as UpdateFixChecksDto);

  beforeEach(() => {
    repo = {
      findById: vi.fn().mockResolvedValue(row()),
      updateFixChecks: vi.fn().mockImplementation(async (_id, value) => row({ fixTrustDetectedChecks: value })),
    };
    tx = { run: vi.fn((fn: () => Promise<unknown>) => fn()) };
    audit = { record: vi.fn() };
    permissions = { canHoldKey: vi.fn().mockResolvedValue(true) };
  });

  it('AC-11: enabling records one audit entry with the review key, repo resource, id and enabled summary', async () => {
    const result = await configure(true);
    expect(repo.updateFixChecks).toHaveBeenCalledExactlyOnceWith('r1', true);
    expect(audit.record).toHaveBeenCalledExactlyOnceWith({
      key: 'fleet.repo.review.configure', resourceType: 'fleet-repo', resourceId: 'r1',
      projectId: 'p1', summary: 'fix detected checks enabled',
    });
    expect(result).toMatchObject({ id: 'r1', fixTrustDetectedChecks: true });
  });

  it('AC-11: disabling records one audit entry with the disabled summary', async () => {
    const result = await configure(false);
    expect(repo.updateFixChecks).toHaveBeenCalledExactlyOnceWith('r1', false);
    expect(audit.record).toHaveBeenCalledExactlyOnceWith({
      key: 'fleet.repo.review.configure', resourceType: 'fleet-repo', resourceId: 'r1',
      projectId: 'p1', summary: 'fix detected checks disabled',
    });
    expect(result).toMatchObject({ id: 'r1', fixTrustDetectedChecks: false });
  });

  it('records the audit inside the transaction that holds the write', async () => {
    const events: string[] = [];
    tx.run.mockImplementation(async (fn: () => Promise<unknown>) => { events.push('begin'); const value = await fn(); events.push('end'); return value; });
    repo.updateFixChecks.mockImplementation(async () => { events.push('update'); return row({ fixTrustDetectedChecks: true }); });
    audit.record.mockImplementation(async () => { events.push('audit'); });
    await configure(true);
    expect(events).toEqual(['begin', 'update', 'audit', 'end']);
  });

  it('404s an unknown repo with the fleet.repos key and writes nothing', async () => {
    repo.findById.mockResolvedValue(null);
    await expect(configure(true)).rejects.toBeInstanceOf(NotFoundAppException);
    await expect(configure(true)).rejects.toMatchObject({ prefix: 'fleet.repos' });
    expect(repo.updateFixChecks).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each([
    { provider: 'gitlab' },
    { githubInstallationId: null },
  ])('refuses to enable on a repo without a GitHub App installation: %o', async (overrides) => {
    repo.findById.mockResolvedValue(row(overrides));
    const error = await configure(true).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(FixChecksException);
    expect(error).toMatchObject({ reason: 'github app required', status: 422 });
    expect(repo.updateFixChecks).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each([
    { provider: 'gitlab' },
    { githubInstallationId: null },
  ])('always allows disabling: %o', async (overrides) => {
    repo.findById.mockResolvedValue(row(overrides));
    await expect(configure(false)).resolves.toMatchObject({ fixTrustDetectedChecks: false });
    expect(repo.updateFixChecks).toHaveBeenCalledExactlyOnceWith('r1', false);
  });

  it('needs no dispatch permission from its caller', async () => {
    permissions.canHoldKey.mockResolvedValue(false);
    await expect(configure(true)).resolves.toMatchObject({ fixTrustDetectedChecks: true });
    expect(permissions.canHoldKey).not.toHaveBeenCalled();
  });
});
