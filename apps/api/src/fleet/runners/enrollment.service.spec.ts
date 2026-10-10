import { AuthException } from '@nathapp/nestjs-common';
import { EnrollmentService } from './enrollment.service';
import { ProtocolVersionException } from './protocol-version.exception';
import { testFleetConfig } from '../../common/test-helpers/fleet-config';

const caps = {
  nax: { version: '0.83.0', protocols: ['native'] },
  sandbox: { available: true, probedAt: '2026-09-30T00:00:00.000Z' },
  profiles: {}, credentials: [], tools: { git: true, gh: true, glab: false }, executors: ['host'],
};
const body = {
  enrollmentToken: 'ke_abc', name: 'mac-1', os: 'darwin', arch: 'arm64', daemonVersion: '0.1.0',
  protocolVersion: 1, bootId: 'boot-1', labels: ['darwin', 'fast'], capabilities: caps,
};

describe('EnrollmentService', () => {
  const repo = {
    createEnrollment: vi.fn(), findEnrollmentPage: vi.fn(), consumeEnrollment: vi.fn(),
    createRunner: vi.fn(), linkEnrollment: vi.fn(),
  };
  const activity = { record: vi.fn() };
  const tx = { run: <T>(fn: () => Promise<T>) => fn(), isInTransaction: () => false };
  const service = new EnrollmentService(
    repo as never, activity as never, tx as never,
    { apiKeySecret: 's3cret' } as never, testFleetConfig({ enrollmentTtlSec: 3600 }),
  );

  beforeEach(() => vi.clearAllMocks());

  it('issues a ke_ token once, stores only its hash, and records activity', async () => {
    repo.createEnrollment.mockImplementation(async (d) => ({ id: 'e1', labels: d.labels, expiresAt: d.expiresAt, usedAt: null, runnerId: null, createdById: 'u1', createdAt: new Date() }));
    const created = await service.create('u1', ['gpu', 'gpu', 'linux']);
    expect(created.token).toMatch(/^ke_[0-9a-f]{64}$/);
    expect(created.labels).toEqual(['gpu', 'linux']);
    const stored = repo.createEnrollment.mock.calls[0][0];
    expect(stored.tokenHash).not.toContain(created.token);
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'enrollment.created', entityId: 'e1', payload: { labels: ['gpu', 'linux'] } }));
  });

  it('rejects an unsupported protocol version before touching the token', async () => {
    // 2 became supported with protocol v2 (S1.5); 99 stays unsupported for every version of the table.
    await expect(service.enroll({ ...body, protocolVersion: 99 } as never)).rejects.toBeInstanceOf(ProtocolVersionException);
    expect(repo.consumeEnrollment).not.toHaveBeenCalled();
  });

  it('rejects a token without the ke_ prefix with the bad-token 401 before any lookup (#157)', async () => {
    for (const enrollmentToken of ['abc', 'kr_' + 'a'.repeat(64), 'KE_abc', '']) {
      await expect(service.enroll({ ...body, enrollmentToken } as never)).rejects.toBeInstanceOf(AuthException);
    }
    expect(repo.consumeEnrollment).not.toHaveBeenCalled();
  });

  it('rejects a used, expired or unknown token with 401', async () => {
    repo.consumeEnrollment.mockResolvedValue(null);
    await expect(service.enroll(body as never)).rejects.toBeInstanceOf(AuthException);
    expect(repo.createRunner).not.toHaveBeenCalled();
  });

  it('creates the runner with merged labels and returns a kr_ key once', async () => {
    repo.consumeEnrollment.mockResolvedValue({ id: 'e1', labels: ['gpu', 'darwin'], createdById: 'u1' });
    repo.createRunner.mockImplementation(async (d) => ({ id: 'r1', ...d }));
    const result = await service.enroll(body as never);
    expect(result.apiKey).toMatch(/^kr_[0-9a-f]{64}$/);
    expect(result.runnerId).toBe('r1');
    const data = repo.createRunner.mock.calls[0][0];
    expect(data.labels).toEqual(['darwin', 'fast', 'gpu']);
    expect(data.apiKeyHash).not.toContain(result.apiKey);
    expect(data.bootedAt).toBeInstanceOf(Date);
    expect(data.bootedAt).toEqual(data.lastSeenAt);
    expect(repo.linkEnrollment).toHaveBeenCalledWith('e1', 'r1');
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ actorType: 'RUNNER', actorId: 'r1', action: 'runner.enrolled', responsibleUserId: 'u1' }));
  });
});
