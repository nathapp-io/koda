import { ValidationAppException } from '@nathapp/nestjs-common';
import { VcsConnectionService } from './vcs-connection.service';
import { VcsProviderType, VcsSyncModeType } from './dto/create-vcs-connection.dto';
import type { IVcsRepository } from './domain/vcs.repository';
import type { VcsPollingService } from './vcs-polling.service';
import type { IVcsConfig } from '../config/vcs.config';

const KEY = 'ab'.repeat(32);
const config = {
  encryptionKey: KEY,
  defaultPollingIntervalMs: 600000,
  githubApiUrl: 'https://api.github.com',
  gitlabApiUrl: 'https://gitlab.com/api/v4',
} as IVcsConfig;

function connectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1', projectId: 'p1', provider: 'gitlab', repoOwner: 'grp/sub', repoName: 'app',
    encryptedToken: 'enc', syncMode: 'polling', allowedAuthors: '[]', pollingIntervalMs: 600000,
    webhookSecret: 's'.repeat(32), isActive: true, lastSyncedAt: null,
    createdAt: new Date(), updatedAt: new Date(), ...overrides,
  };
}

describe('VcsConnectionService — GitLab (BUG-14)', () => {
  let repo: Record<string, jest.Mock>;
  let service: VcsConnectionService;

  beforeEach(() => {
    repo = {
      findProjectById: jest.fn().mockResolvedValue({ id: 'p1' }),
      findVcsConnectionByProjectId: jest.fn().mockResolvedValue(null),
      createVcsConnection: jest.fn().mockImplementation(async (data) => connectionRow(data)),
      updateVcsConnection: jest.fn().mockImplementation(async (_id, data) => connectionRow(data)),
    };
    const polling = { refreshConnectionSchedule: jest.fn().mockResolvedValue(undefined) };
    service = new VcsConnectionService(repo as unknown as IVcsRepository, config, polling as unknown as VcsPollingService);
  });

  const refusal = async (promise: Promise<unknown>) => {
    const error = await promise.then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationAppException);
    expect((error as ValidationAppException).prefix).toBe('vcs.gitlabWebhook');
  };

  it('creates a polling GitLab connection from a self-hosted subgroup URL', async () => {
    await service.create('p1', KEY, {
      provider: VcsProviderType.GITLAB,
      repoOwner: 'ignored',
      repoName: 'ignored',
      repoUrl: 'https://git.corp/grp/sub/app.git',
      token: 'glpat-x',
      syncMode: VcsSyncModeType.POLLING,
    });

    expect(repo.createVcsConnection).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'gitlab', repoOwner: 'grp/sub', repoName: 'app', syncMode: 'polling' }),
    );
  });

  it('refuses webhook mode for a new GitLab connection', async () => {
    await refusal(service.create('p1', KEY, {
      provider: VcsProviderType.GITLAB, repoOwner: 'g', repoName: 'r', token: 't', syncMode: VcsSyncModeType.WEBHOOK,
    }));
    expect(repo.createVcsConnection).not.toHaveBeenCalled();
  });

  it('refuses switching an existing GitLab connection to webhook mode', async () => {
    repo.findVcsConnectionByProjectId.mockResolvedValue(connectionRow());

    await refusal(service.update('p1', KEY, { syncMode: VcsSyncModeType.WEBHOOK }));
    expect(repo.updateVcsConnection).not.toHaveBeenCalled();
  });
});
