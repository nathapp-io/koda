import { FleetRepoDto } from './fleet-repo.dto';
import type { FleetRepoRecord } from '../domain/fleet-repo.domain';

describe('FleetRepoDto auto-review fields', () => {
  const record = (over: Partial<FleetRepoRecord> = {}): FleetRepoRecord => ({
    id: 'r', projectId: 'p', provider: 'github', owner: 'o', name: 'n', defaultBranch: 'main',
    githubInstallationId: null, createdById: 'u', createdAt: new Date(0), autoReview: true,
    autoReviewProfiles: ['review'], autoReviewMaxCostUsd: '2.5', autoReviewEnabledById: 'u',
    autoReviewEnabledByType: 'USER', autoReviewEnabledAt: new Date('2026-11-01T00:00:00.000Z'), ...over,
  });

  it('serializes all auto-review properties including fixed decimal and ISO date', () => {
    expect(FleetRepoDto.from(record())).toMatchObject({
      autoReview: true, autoReviewProfiles: ['review'], autoReviewMaxCostUsd: '2.5000',
      autoReviewEnabledById: 'u', autoReviewEnabledByType: 'USER', autoReviewEnabledAt: '2026-11-01T00:00:00.000Z',
    });
  });
});

describe('FleetRepoDto fix-checks field (US-001)', () => {
  const record = (over: Partial<FleetRepoRecord> = {}): FleetRepoRecord => ({
    id: 'r', projectId: 'p', provider: 'github', owner: 'o', name: 'n', defaultBranch: 'main',
    githubInstallationId: null, createdById: 'u', createdAt: new Date(0), autoReview: false,
    autoReviewProfiles: [], autoReviewMaxCostUsd: '1', autoReviewEnabledById: null,
    autoReviewEnabledByType: null, autoReviewEnabledAt: null, ...over,
  });

  it('AC-13: a record without the field serializes as false', () => {
    expect(FleetRepoDto.from(record()).fixTrustDetectedChecks).toBe(false);
  });

  it('AC-13: a record with the field true serializes as true', () => {
    expect(FleetRepoDto.from(record({ fixTrustDetectedChecks: true })).fixTrustDetectedChecks).toBe(true);
  });
});

describe('FleetRepoDto fix-unprotected field', () => {
  const record = (over: Partial<FleetRepoRecord> = {}): FleetRepoRecord => ({
    id: 'r', projectId: 'p', provider: 'github', owner: 'o', name: 'n', defaultBranch: 'main',
    githubInstallationId: null, createdById: 'u', createdAt: new Date(0), autoReview: false,
    autoReviewProfiles: [], autoReviewMaxCostUsd: '1', autoReviewEnabledById: null,
    autoReviewEnabledByType: null, autoReviewEnabledAt: null, ...over,
  });

  it('a record without the field serializes as false', () => {
    expect(FleetRepoDto.from(record()).fixAllowUnprotected).toBe(false);
  });

  it('a record with the field true serializes as true', () => {
    expect(FleetRepoDto.from(record({ fixAllowUnprotected: true })).fixAllowUnprotected).toBe(true);
  });
});

describe('FleetRepoDto host and GitLab connection (US-001)', () => {
  const now = new Date('2026-12-16T00:00:00.000Z');
  const record = (over: Partial<FleetRepoRecord> = {}): FleetRepoRecord => ({
    id: 'r', projectId: 'p', provider: 'github', owner: 'o', name: 'n', defaultBranch: 'main',
    githubInstallationId: null, createdById: 'u', createdAt: new Date(0), autoReview: false,
    autoReviewProfiles: [], autoReviewMaxCostUsd: '1', autoReviewEnabledById: null,
    autoReviewEnabledByType: null, autoReviewEnabledAt: null, ...over,
  });
  const credential = (over: Partial<NonNullable<FleetRepoRecord['gitlabCredential']>> = {}): NonNullable<FleetRepoRecord['gitlabCredential']> => ({
    gitlabProjectId: 4711,
    readTokenUsername: 'koda-read',
    writeTokenUsername: 'koda-bot',
    writeTokenIsBot: true,
    readTokenExpiresAt: null,
    writeTokenExpiresAt: null,
    readTokenInvalidAt: null,
    writeTokenInvalidAt: null,
    ...over,
  });

  it('AC-15: a GitHub row answers the default host and no GitLab connection', () => {
    const dto = FleetRepoDto.from(record(), now);

    expect(dto.host).toBe('https://github.com');
    expect(dto.gitlab).toBeNull();
  });

  it('AC-15: a GitLab row whose write token belongs to a person warns about it', () => {
    const dto = FleetRepoDto.from(record({
      provider: 'gitlab', host: 'https://gitlab.example.com',
      gitlabCredential: credential({ writeTokenIsBot: false }),
    }), now);

    expect(dto.host).toBe('https://gitlab.example.com');
    expect(dto.gitlab).toMatchObject({
      projectId: 4711,
      readToken: { username: 'koda-read', expiresAt: null, status: 'ok' },
      writeToken: { username: 'koda-bot', expiresAt: null, status: 'ok', isBot: false },
    });
    expect(dto.gitlab?.warnings).toEqual(['write_token_human']);
  });

  it('a GitLab row whose write token belongs to a bot carries no warning', () => {
    const dto = FleetRepoDto.from(record({ provider: 'gitlab', gitlabCredential: credential() }), now);

    expect(dto.gitlab?.warnings).toEqual([]);
    expect(dto.gitlab?.writeToken.isBot).toBe(true);
  });

  it('a GitLab row without a credential record carries no GitLab connection', () => {
    expect(FleetRepoDto.from(record({ provider: 'gitlab', gitlabCredential: null }), now).gitlab).toBeNull();
  });

  it('the token status follows the expiry and the invalid mark', () => {
    const expiring = FleetRepoDto.from(record({
      provider: 'gitlab',
      gitlabCredential: credential({ readTokenExpiresAt: new Date('2026-12-20T00:00:00.000Z'), writeTokenInvalidAt: new Date('2026-12-15T00:00:00.000Z') }),
    }), now);

    expect(expiring.gitlab?.readToken.status).toBe('expiring');
    expect(expiring.gitlab?.writeToken.status).toBe('invalid');
  });
});
