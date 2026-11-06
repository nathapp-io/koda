import { createMock } from '@golevelup/ts-vitest';
import { ValidationAppException } from '@nathapp/nestjs-common';
import type { ITransactionManager } from '@nathapp/nestjs-data';
import { FleetJobKind, FleetJobState } from '../../common/enums';
import { FleetActivityService } from '../activity/fleet-activity.service';
import type { FleetJobRecord, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { GitTokenBroker } from '../git-broker/git-token.broker';
import { PlacementService } from '../jobs/placement.service';
import type { ProviderCredential } from '../provider-credentials/provider-credential.domain';
import type { ProviderCredentialsService } from '../provider-credentials/provider-credentials.service';
import type { ChatThreadRepository } from '../threads/domain/chat-thread.domain';
import { RunnerNotifier } from '../jobs/runner-notifier';
import { CommandAckProcessor } from './command-ack.processor';
import { FenceService } from './fence.service';
import { SyncService } from './sync.service';
import { parseSyncRequest } from './sync-request.parser';

const base = { protocolVersion: 4, bootId: 'b1', daemonVersion: '1', freeSlots: 0, jobs: [], commandAcks: [], tokenRequests: [] };
const lease = 3;

const credential = (over: Partial<ProviderCredential> = {}): ProviderCredential => ({
  id: 'cred-1', scope: 'GLOBAL', scopeKey: 'global', projectId: null, repoId: null,
  providerId: 'openrouter', name: 'fleet', encryptedKey: 'aa:bb:cc', last4: '3456',
  fingerprint: '0123456789ab', createdById: 'u1', updatedById: 'u1', disabledAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'), updatedAt: new Date('2026-01-01T00:00:00.000Z'), ...over,
});

function harness() {
  const repo = createMock<IFleetJobRepository>();
  const job = {
    id: 'j1', projectId: 'p1', repoId: 'r1', runnerId: 'runner1', leaseEpoch: lease,
    command: FleetJobKind.RUN, state: FleetJobState.RUNNING, requestedById: 'u1', requestedByType: 'USER',
  } as FleetJobRecord;
  repo.lockById.mockResolvedValue(job);
  repo.recordRunnerSync.mockResolvedValue({ previousBootId: 'b1' });
  repo.findPendingCommands.mockResolvedValue([]);
  repo.findThreadCredentialScope.mockResolvedValue({ projectId: 'thread-project', repoId: 'thread-repo' });

  const notifier = createMock<RunnerNotifier>();
  const fence = createMock<FenceService>();
  fence.holds.mockReturnValue(true);
  const credentials = createMock<ProviderCredentialsService>();
  credentials.isEnabled.mockReturnValue(true);
  credentials.resolve.mockResolvedValue(credential());
  credentials.issueKey.mockReturnValue('sk-or-abcdef123456');
  credentials.recordIssue.mockResolvedValue(true);
  const activity = createMock<FleetActivityService>();
  const tx = createMock<ITransactionManager>({ run: async (fn) => fn() });

  const service = new SyncService(
    repo, createMock(), createMock<CommandAckProcessor>({ process: async () => ({ live: [] }) }),
    createMock<PlacementService>(), createMock(), notifier, { syncWaitMs: 5_000 },
    createMock<GitTokenBroker>(), fence, createMock(), createMock(), tx, createMock(),
    createMock<ChatThreadRepository>({ archivedThreadIds: async () => [] }), credentials, activity,
  );
  const sync = (providerRequests: unknown[], overrides: Record<string, unknown> = {}) =>
    service.sync('runner1', { ...base, ...overrides, providerRequests });
  const request = (over: Record<string, unknown> = {}) => [{ jobId: 'j1', leaseEpoch: lease, providerId: 'openrouter', ...over }];
  return { repo, job, notifier, fence, credentials, activity, sync, request };
}

describe('sync provider credential requests', () => {
  it('AC-15: parseSyncRequest refuses more than 64 provider requests', () => {
    const many = Array.from({ length: 65 }, () => ({ jobId: 'j1', leaseEpoch: 1, providerId: 'openrouter' }));
    let error: unknown;
    try {
      parseSyncRequest({ ...base, providerRequests: many });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ValidationAppException);
    expect(error).toMatchObject({ args: { reason: 'providerRequests' } });
    expect(parseSyncRequest({ ...base, providerRequests: many.slice(0, 64) }).providerRequests).toHaveLength(64);
  });

  it('AC-15: parseSyncRequest rejects a malformed provider request', () => {
    for (const bad of [{ jobId: '', leaseEpoch: 1, providerId: 'openrouter' }, { jobId: 'j1', leaseEpoch: -1, providerId: 'openrouter' }, { jobId: 'j1', leaseEpoch: 1, providerId: 'Bad Id' }]) {
      expect(() => parseSyncRequest({ ...base, providerRequests: [bad] })).toThrow(ValidationAppException);
    }
    expect(parseSyncRequest({ ...base, providerRequests: [{ jobId: 'j1', leaseEpoch: 1, providerId: 'openrouter' }] }).providerRequests)
      .toEqual([{ jobId: 'j1', leaseEpoch: 1, providerId: 'openrouter' }]);
  });

  it('grants the resolved key with its account, fingerprint and a ten-minute lease', async () => {
    const h = harness();
    const before = Date.now();
    const response = await h.sync(h.request());
    const after = Date.now();

    expect(response.providerKeys).toHaveLength(1);
    expect(response.providerKeys[0]).toMatchObject({
      jobId: 'j1', providerId: 'openrouter', key: 'sk-or-abcdef123456',
      account: 'koda:global:fleet', fingerprint: '0123456789ab',
    });
    const expiresAt = Date.parse(response.providerKeys[0].expiresAt);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 600_000);
    expect(expiresAt).toBeLessThanOrEqual(after + 600_000);
    expect(response.providerKeyErrors).toEqual([]);
    expect(h.credentials.resolve).toHaveBeenCalledExactlyOnceWith({ projectId: 'p1', repoId: 'r1', providerId: 'openrouter' });
  });

  it('answers vault_off without resolving when the vault is disabled', async () => {
    const h = harness();
    h.credentials.isEnabled.mockReturnValue(false);

    const response = await h.sync(h.request());

    expect(response.providerKeys).toEqual([]);
    expect(response.providerKeyErrors).toEqual([{ jobId: 'j1', providerId: 'openrouter', reason: 'vault_off' }]);
    expect(h.credentials.resolve).not.toHaveBeenCalled();
  });

  it('answers none when no key resolves', async () => {
    const h = harness();
    h.credentials.resolve.mockResolvedValue(null);

    const response = await h.sync(h.request());

    expect(response.providerKeys).toEqual([]);
    expect(response.providerKeyErrors).toEqual([{ jobId: 'j1', providerId: 'openrouter', reason: 'none' }]);
    expect(h.credentials.recordIssue).not.toHaveBeenCalled();
  });

  it('answers none when the resolved ciphertext cannot be decrypted', async () => {
    const h = harness();
    h.credentials.issueKey.mockReturnValue(null);

    const response = await h.sync(h.request());

    expect(response.providerKeys).toEqual([]);
    expect(response.providerKeyErrors).toEqual([{ jobId: 'j1', providerId: 'openrouter', reason: 'none' }]);
    expect(h.credentials.recordIssue).not.toHaveBeenCalled();
  });

  it('answers job_not_active for a job the runner no longer holds a lease on', async () => {
    const h = harness();
    h.job.state = FleetJobState.COMPLETED;

    const response = await h.sync(h.request());

    expect(response.providerKeyErrors).toEqual([{ jobId: 'j1', providerId: 'openrouter', reason: 'job_not_active' }]);
    expect(h.credentials.resolve).not.toHaveBeenCalled();
  });

  it('abandons a stale lease without disclosing a key', async () => {
    const h = harness();
    h.fence.holds.mockReturnValue(false);

    const response = await h.sync(h.request({ leaseEpoch: lease + 1 }));

    expect(h.fence.holds).toHaveBeenCalledWith(h.job, 'runner1', lease + 1);
    expect(h.fence.abandon).toHaveBeenCalledExactlyOnceWith('runner1', h.job, lease + 1);
    expect(response.providerKeys).toEqual([]);
    expect(response.providerKeyErrors).toEqual([]);
    expect(h.credentials.resolve).not.toHaveBeenCalled();
  });

  it('locks the job before the fence and before any resolution', async () => {
    const h = harness();
    await h.sync(h.request());
    expect(h.repo.lockById).toHaveBeenCalledExactlyOnceWith('j1');
    expect(h.repo.lockById.mock.invocationCallOrder[0]).toBeLessThan(h.credentials.resolve.mock.invocationCallOrder[0]);
  });

  it('review F1: locks every distinct job in jobId order, whatever order the batch arrives in', async () => {
    const h = harness();
    h.repo.lockById.mockImplementation(async (id: string) => ({ ...h.job, id }));

    const response = await h.sync([
      { jobId: 'j3', leaseEpoch: lease, providerId: 'openrouter' },
      { jobId: 'j1', leaseEpoch: lease, providerId: 'openrouter' },
      { jobId: 'j2', leaseEpoch: lease, providerId: 'openrouter' },
      { jobId: 'j1', leaseEpoch: lease, providerId: 'openrouter' },
    ]);

    // A consistent order is what keeps two overlapping reversed batches from deadlocking on each other.
    expect(h.repo.lockById.mock.calls.map(([jobId]) => jobId)).toEqual(['j1', 'j2', 'j3']);
    // The answer still follows the request order, and a repeated job is locked once.
    expect(response.providerKeys.map((grant) => grant.jobId)).toEqual(['j3', 'j1', 'j2', 'j1']);
    expect(response.providerKeyErrors).toEqual([]);
  });

  it('scopes a thread job from the thread, not from the job row', async () => {
    const h = harness();
    h.job.command = FleetJobKind.THREAD;

    await h.sync(h.request());

    expect(h.repo.findThreadCredentialScope).toHaveBeenCalledExactlyOnceWith('j1');
    expect(h.credentials.resolve).toHaveBeenCalledExactlyOnceWith({ projectId: 'thread-project', repoId: 'thread-repo', providerId: 'openrouter' });
  });

  it('does not read a thread scope for a fleet job', async () => {
    const h = harness();
    await h.sync(h.request());
    expect(h.repo.findThreadCredentialScope).not.toHaveBeenCalled();
  });

  it('answers none when a thread job has no thread scope', async () => {
    const h = harness();
    h.job.command = FleetJobKind.THREAD;
    h.repo.findThreadCredentialScope.mockResolvedValue(null);

    const response = await h.sync(h.request());

    expect(response.providerKeyErrors).toEqual([{ jobId: 'j1', providerId: 'openrouter', reason: 'none' }]);
    expect(h.credentials.resolve).not.toHaveBeenCalled();
  });

  it('records credential.issued once per (job, credential, fingerprint)', async () => {
    const h = harness();

    await h.sync(h.request());

    expect(h.credentials.recordIssue).toHaveBeenCalledExactlyOnceWith({ jobId: 'j1', credentialId: 'cred-1', fingerprint: '0123456789ab' });
    expect(h.activity.record).toHaveBeenCalledExactlyOnceWith({
      actorType: 'RUNNER', actorId: 'runner1', action: 'credential.issued', entityType: 'provider_credential',
      entityId: 'cred-1', jobId: 'j1', projectId: 'p1', responsibleUserId: 'u1',
      payload: { providerId: 'openrouter', scope: 'GLOBAL', name: 'fleet', fingerprint: '0123456789ab' },
    });
  });

  it('records no second activity row when the issue row already exists', async () => {
    const h = harness();
    h.credentials.recordIssue.mockResolvedValue(false);

    const response = await h.sync(h.request());

    expect(response.providerKeys).toHaveLength(1);
    expect(h.activity.record).not.toHaveBeenCalled();
  });

  it('does not wait on the long poll when the only content is a provider grant', async () => {
    const h = harness();

    const response = await h.sync(h.request());

    expect(response.providerKeys).toHaveLength(1);
    expect(h.notifier.wait).not.toHaveBeenCalled();
  });

  it('does not wait on the long poll when the only content is a provider error', async () => {
    const h = harness();
    h.credentials.resolve.mockResolvedValue(null);

    await h.sync(h.request());

    expect(h.notifier.wait).not.toHaveBeenCalled();
  });

  it('keeps an unknown job on the unknownJobIds path', async () => {
    const h = harness();
    h.repo.lockById.mockResolvedValue(null);

    const response = await h.sync(h.request());

    expect(response.unknownJobIds).toEqual(['j1']);
    expect(response.providerKeyErrors).toEqual([]);
    expect(h.credentials.resolve).not.toHaveBeenCalled();
  });
});
