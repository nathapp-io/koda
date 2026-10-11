import type { Mock } from 'vitest';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { VcsConnectionService } from './vcs-connection.service';
import { VcsProviderType, VcsSyncModeType } from './dto/create-vcs-connection.dto';
import type { IVcsRepository } from './domain/vcs.repository';
import type { VcsPollingService } from './vcs-polling.service';
import type { IVcsConfig } from '../config/vcs.config';

const KEY = 'ab'.repeat(32);
const HEX_32 = /^[0-9a-f]{32}$/;

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1', projectId: 'p1', provider: 'github', repoOwner: 'o', repoName: 'r', encryptedToken: 'enc',
    syncMode: 'off', allowedAuthors: '[]', pollingIntervalMs: 600000, webhookSecret: 'old'.padEnd(32, '0'),
    isActive: true, lastSyncedAt: null, createdAt: new Date(), updatedAt: new Date(), ...overrides,
  };
}

describe('VcsConnectionService webhook secret (M9)', () => {
  let repo: Record<string, Mock>;
  let service: VcsConnectionService;

  beforeEach(() => {
    repo = {
      findProjectById: vi.fn().mockResolvedValue({ id: 'p1' }),
      findVcsConnectionByProjectId: vi.fn().mockResolvedValue(null),
      createVcsConnection: vi.fn().mockImplementation(async (data) => row(data)),
      updateVcsConnection: vi.fn().mockImplementation(async (_p, data) => row(data)),
    };
    service = new VcsConnectionService(
      repo as unknown as IVcsRepository,
      { encryptionKey: KEY, defaultPollingIntervalMs: 600000, githubApiUrl: 'https://api.github.com', gitlabApiUrl: 'https://gitlab.com/api/v4' } as IVcsConfig,
      { refreshConnectionSchedule: vi.fn() } as unknown as VcsPollingService,
    );
  });

  it('create returns the stored secret once', async () => {
    const created = await service.create('p1', KEY, { provider: VcsProviderType.GITHUB, repoOwner: 'o', repoName: 'r', token: 't' });

    const stored = repo.createVcsConnection.mock.calls[0][0].webhookSecret;
    expect(created.webhookSecret).toMatch(HEX_32);
    expect(created.webhookSecret).toBe(stored);
    expect(created.webhookSecretConfigured).toBe(true);
  });

  it('reads never include the secret', async () => {
    repo.findVcsConnectionByProjectId.mockResolvedValue(row());
    const read = await service.findByProject('p1');
    expect(read).not.toHaveProperty('webhookSecret');
  });

  it('update returns a secret only when it generated one for a legacy row', async () => {
    repo.findVcsConnectionByProjectId.mockResolvedValue(row({ webhookSecret: null }));
    const enabled = await service.update('p1', KEY, { syncMode: VcsSyncModeType.WEBHOOK });
    expect(enabled.webhookSecret).toMatch(HEX_32);

    repo.findVcsConnectionByProjectId.mockResolvedValue(row());
    const plain = await service.update('p1', KEY, { syncMode: VcsSyncModeType.POLLING });
    expect(plain).not.toHaveProperty('webhookSecret');
  });

  it('rotate stores and returns a new secret', async () => {
    repo.findVcsConnectionByProjectId.mockResolvedValue(row());

    const { webhookSecret } = await service.rotateWebhookSecret('p1');

    expect(webhookSecret).toMatch(HEX_32);
    expect(webhookSecret).not.toBe(row().webhookSecret);
    expect(repo.updateVcsConnection).toHaveBeenCalledWith('p1', { webhookSecret });
  });

  it('rotate 404s without a connection', async () => {
    await expect(service.rotateWebhookSecret('p1')).rejects.toBeInstanceOf(NotFoundAppException);
  });
});
