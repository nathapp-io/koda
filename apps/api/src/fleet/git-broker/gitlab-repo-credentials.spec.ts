import { createMockPrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../../generated/prisma/client';
import { decryptToken } from '../../common/utils/encryption.util';
import { GitLabRepoCredentials, gitlabTokenStatus } from './gitlab-repo-credentials';
import { GitTokenBroker } from './git-token.broker';
import { GitLabAccessChecker } from './gitlab-access-checker';
import type { FleetRepoRef } from '../jobs/domain/fleet-job.domain';
import { PrismaGitlabCredentialRepository } from './prisma-gitlab-credential.repository';
import { RepoCheckException } from './repo-check.exception';

/** The key the store encrypts under; 32 bytes of hex, as `VCS_ENCRYPTION_KEY` holds it. */
const KEY = 'a'.repeat(64);
const REPO = { id: 'repo-1', host: 'https://gitlab.example.com' };

/** The row the `FleetRepoGitlabCredential` table holds, as the repository reads and writes it. */
interface StoredRow {
  id: string;
  repoId: string;
  gitlabProjectId: number;
  encryptedReadToken: string;
  encryptedWriteToken: string;
  readTokenUserId: number;
  readTokenUsername: string;
  writeTokenUserId: number;
  writeTokenUsername: string;
  writeTokenIsBot: boolean;
  readTokenExpiresAt: Date | null;
  writeTokenExpiresAt: Date | null;
  readTokenInvalidAt: Date | null;
  writeTokenInvalidAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * An in-memory stand-in for the `FleetRepoGitlabCredential` delegate: the row store the repository
 * reads and writes, so the merge rules of a save (what a rotation replaces and what it keeps) are
 * the production ones and not a mock's guess.
 */
class InMemoryCredentialDelegate {
  readonly rows = new Map<string, StoredRow>();
  private seq = 0;

  async findUnique(args: { where: { repoId: string } }): Promise<StoredRow | null> {
    return this.rows.get(args.where.repoId) ?? null;
  }

  async create(args: { data: Partial<StoredRow> & { repoId: string } }): Promise<StoredRow> {
    const row: StoredRow = {
      id: `cred-${++this.seq}`,
      createdAt: new Date(),
      updatedAt: new Date(),
      readTokenInvalidAt: null,
      writeTokenInvalidAt: null,
      ...args.data,
    } as StoredRow;
    this.rows.set(row.repoId, row);
    return row;
  }

  async update(args: { where: { repoId: string }; data: Partial<StoredRow> }): Promise<StoredRow> {
    const row = this.rows.get(args.where.repoId);
    if (!row) throw new Error(`no credential row for ${args.where.repoId}`);
    Object.assign(row, args.data, { updatedAt: new Date() });
    return row;
  }

  async updateMany(args: { where: { repoId: string }; data: Partial<StoredRow> }): Promise<{ count: number }> {
    const row = this.rows.get(args.where.repoId);
    if (!row) return { count: 0 };
    Object.assign(row, args.data, { updatedAt: new Date() });
    return { count: 1 };
  }
}

describe('GitLabRepoCredentials', () => {
  let delegate: InMemoryCredentialDelegate;
  let repository: PrismaGitlabCredentialRepository;
  let store: GitLabRepoCredentials;

  const build = (config: { encryptionKey: string | undefined } = { encryptionKey: KEY }): GitLabRepoCredentials =>
    new GitLabRepoCredentials(repository, config);

  const stored = (): StoredRow => {
    const row = delegate.rows.get(REPO.id);
    if (!row) throw new Error('no credential row stored');
    return row;
  };

  /** A full credential: both tokens, their verified owners and their expiry. */
  const fullInput = () => ({
    gitlabProjectId: 4711,
    read: { token: 'glpat-read', userId: 11, username: 'koda-read', expiresAt: new Date('2027-01-01T00:00:00.000Z') },
    write: { token: 'glpat-write', userId: 12, username: 'koda-bot', expiresAt: null, isBot: true },
  });

  beforeEach(() => {
    delegate = new InMemoryCredentialDelegate();
    const prisma = createMockPrismaService({ fn: vi.fn });
    prisma.client.fleetRepoGitlabCredential = delegate as never;
    repository = new PrismaGitlabCredentialRepository(prisma as unknown as PrismaService<PrismaClient>);
    store = build();
  });

  it('AC-5: a saved write token resolves against the repo host, with the stored project id', async () => {
    await store.save(REPO.id, fullInput());

    await expect(store.resolve(REPO, 'write')).resolves.toEqual({
      token: 'glpat-write',
      target: { apiBase: 'https://gitlab.example.com/api/v4', projectId: 4711 },
    });
  });

  it('AC-5: a repo without a host resolves against gitlab.com', async () => {
    await store.save(REPO.id, fullInput());

    await expect(store.resolve({ id: REPO.id }, 'write')).resolves.toMatchObject({
      target: { apiBase: 'https://gitlab.com/api/v4' },
    });
    await expect(store.resolve({ id: REPO.id, host: '  ' }, 'write')).resolves.toMatchObject({
      target: { apiBase: 'https://gitlab.com/api/v4' },
    });
  });

  it('AC-6: the read token resolves, and it is not the write token', async () => {
    await store.save(REPO.id, fullInput());

    const access = await store.resolve(REPO, 'read');
    expect(access.token).toBe('glpat-read');
    expect(access.token).not.toBe('glpat-write');
  });

  it('AC-7: the stored tokens are ciphertext that decrypts back to the plaintext', async () => {
    await store.save(REPO.id, fullInput());

    const row = stored();
    expect(row.encryptedReadToken).not.toBe('glpat-read');
    expect(row.encryptedWriteToken).not.toBe('glpat-write');
    expect(decryptToken(row.encryptedReadToken, KEY)).toBe('glpat-read');
    expect(decryptToken(row.encryptedWriteToken, KEY)).toBe('glpat-write');
  });

  it('AC-8: a repo without a credential record is refused', async () => {
    await expect(store.resolve(REPO, 'read')).rejects.toMatchObject({ reason: 'gitlab_credentials_missing' });
    await expect(store.resolve(REPO, 'read')).rejects.toBeInstanceOf(RepoCheckException);
  });

  it('AC-9: an unset encryption key is refused before the record is read', async () => {
    const withoutKey = build({ encryptionKey: undefined });

    await expect(withoutKey.resolve(REPO, 'read')).rejects.toMatchObject({ reason: 'vcs_encryption_key_missing' });
    expect(() => withoutKey.assertKeyConfigured()).toThrow(RepoCheckException);
  });

  it('US-002 AC-10: FIX gate uses real credential call and marks the stored write token invalid', async () => {
    await store.save(REPO.id, fullInput());
    const repo: FleetRepoRef = {
      id: REPO.id, projectId: 'project-1', provider: 'gitlab', owner: 'team', name: 'app',
      defaultBranch: 'main', githubInstallationId: null, host: REPO.host,
    };
    const checker = { getBranchPushState: vi.fn().mockRejectedValue(new RepoCheckException('gitlab_token_invalid')) };
    const broker = new GitTokenBroker(
      { gitTokenReuseMarginSec: 30, gitlabTokenTtlSec: 3600 },
      { mintInstallationToken: vi.fn() } as never,
      store,
      checker as unknown as GitLabAccessChecker,
    );

    await expect(broker.mint({ jobId: 'job-fix', leaseEpoch: 3, repo, purpose: 'fix' }))
      .resolves.toEqual({ ok: false, error: { jobId: 'job-fix', reason: 'gitlab_token_invalid' } });

    expect(checker.getBranchPushState).toHaveBeenCalledWith(expect.objectContaining({ token: 'glpat-write' }), 'main');
    expect(stored().writeTokenInvalidAt).toBeInstanceOf(Date);
    expect(stored().readTokenInvalidAt).toBeNull();
  });

  /**
   * B1: the FIX gate asks GitLab whether the credential's own user can push to the default branch, so the
   * credential it grants must be the one it checked. A rotation between the check and the issuance moved the
   * stored credential: the gate runs again against the new one instead of granting a credential nobody checked.
   */
  describe('B1: a write-token rotation during the FIX gate', () => {
    const repo: FleetRepoRef = {
      id: REPO.id, projectId: 'project-1', provider: 'gitlab', owner: 'team', name: 'app',
      defaultBranch: 'main', githubInstallationId: null, host: REPO.host,
    };
    const brokerWith = (checker: { getBranchPushState: unknown }) => new GitTokenBroker(
      { gitTokenReuseMarginSec: 30, gitlabTokenTtlSec: 3600 },
      { mintInstallationToken: vi.fn() } as never,
      store,
      checker as unknown as GitLabAccessChecker,
    );

    /** The rotation the admin makes while the gate is running: a maintainer's token replaces the bot's. */
    const rotateToMaintainer = async () => {
      await store.save(REPO.id, {
        gitlabProjectId: 4711,
        write: { token: 'glpat-write-maintainer', userId: 13, username: 'koda-maintainer', expiresAt: null, isBot: false },
      });
    };

    it('grants the checked credential and never the rotated one that can push', async () => {
      await store.save(REPO.id, fullInput());
      let rotated = false;
      const checker = {
        // The developer's token cannot push to the protected default branch; the maintainer's can.
        getBranchPushState: vi.fn(async (access: { token: string }) => {
          if (!rotated) {
            rotated = true;
            await rotateToMaintainer();
          }
          return { protected: true, canPush: access.token === 'glpat-write-maintainer' };
        }),
      };
      const broker = brokerWith(checker);

      const result = await broker.mint({ jobId: 'job-fix', leaseEpoch: 3, repo, purpose: 'fix' });

      // The unchecked maintainer credential is never granted: the gate ran again against it and refused it.
      expect(result).toEqual({ ok: false, error: { jobId: 'job-fix', reason: 'default_branch_unprotected' } });
      expect(checker.getBranchPushState).toHaveBeenCalledTimes(2);
      expect(checker.getBranchPushState).toHaveBeenNthCalledWith(1, expect.objectContaining({ token: 'glpat-write' }), 'main');
      expect(checker.getBranchPushState).toHaveBeenNthCalledWith(2, expect.objectContaining({ token: 'glpat-write-maintainer' }), 'main');
    });

    it('checks a rotated credential again and grants it when it is safe', async () => {
      await store.save(REPO.id, fullInput());
      let rotated = false;
      const checker = {
        getBranchPushState: vi.fn(async () => {
          if (!rotated) {
            rotated = true;
            await store.save(REPO.id, {
              gitlabProjectId: 4711,
              write: { token: 'glpat-write-2', userId: 12, username: 'koda-bot', expiresAt: null, isBot: true },
            });
          }
          return { protected: true, canPush: false };
        }),
      };
      const broker = brokerWith(checker);

      const result = await broker.mint({ jobId: 'job-fix', leaseEpoch: 3, repo, purpose: 'fix' });

      expect(result).toMatchObject({ ok: true, token: { token: 'glpat-write-2', username: 'oauth2' } });
      expect(checker.getBranchPushState).toHaveBeenCalledTimes(2);
      expect(checker.getBranchPushState).toHaveBeenNthCalledWith(2, expect.objectContaining({ token: 'glpat-write-2' }), 'main');
    });
  });

  it('AC-10: a call whose token is refused marks that token invalid and rethrows', async () => {
    await store.save(REPO.id, fullInput());
    const failure = new RepoCheckException('gitlab_token_invalid');

    await expect(store.call(REPO, 'read', async () => { throw failure; })).rejects.toBe(failure);

    expect(stored().readTokenInvalidAt).toBeInstanceOf(Date);
    expect(stored().writeTokenInvalidAt).toBeNull();
  });

  it('AC-11: a call that fails for another reason marks no token invalid', async () => {
    await store.save(REPO.id, fullInput());
    const failure = new RepoCheckException('provider_error');

    await expect(store.call(REPO, 'write', async () => { throw failure; })).rejects.toBe(failure);

    expect(stored().readTokenInvalidAt).toBeNull();
    expect(stored().writeTokenInvalidAt).toBeNull();
  });

  it('AC-12: a save that replaces only the write token clears its invalid mark and keeps the read token', async () => {
    await store.save(REPO.id, fullInput());
    await store.markInvalid(REPO.id, 'read');
    await store.markInvalid(REPO.id, 'write');
    expect(stored().readTokenInvalidAt).toBeInstanceOf(Date);
    expect(stored().writeTokenInvalidAt).toBeInstanceOf(Date);

    await store.save(REPO.id, {
      gitlabProjectId: 4711,
      write: { token: 'glpat-write-2', userId: 12, username: 'koda-bot', expiresAt: null, isBot: true },
    });

    expect(stored().writeTokenInvalidAt).toBeNull();
    expect(stored().readTokenInvalidAt).toBeInstanceOf(Date);
    expect(decryptToken(stored().encryptedReadToken, KEY)).toBe('glpat-read');
    expect(decryptToken(stored().encryptedWriteToken, KEY)).toBe('glpat-write-2');
  });

  it('a token that does not decrypt under the configured key is refused as invalid', async () => {
    await store.save(REPO.id, fullInput());
    const other = build({ encryptionKey: 'b'.repeat(64) });

    await expect(other.resolve(REPO, 'read')).rejects.toMatchObject({ reason: 'gitlab_token_invalid' });
  });
});

describe('gitlabTokenStatus', () => {
  const now = new Date('2026-12-16T00:00:00.000Z');
  const inDays = (days: number): Date => new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  it('AC-13: an invalid token is invalid, whatever its expiry says', () => {
    expect(gitlabTokenStatus(inDays(30), new Date(now.getTime() - 1000), now)).toBe('invalid');
    expect(gitlabTokenStatus(null, new Date(now.getTime() - 1000), now)).toBe('invalid');
  });

  it('AC-13: a token expiring within 14 days is expiring', () => {
    expect(gitlabTokenStatus(inDays(14), null, now)).toBe('expiring');
    expect(gitlabTokenStatus(inDays(1), null, now)).toBe('expiring');
    expect(gitlabTokenStatus(inDays(13), null, now)).toBe('expiring');
  });

  it('AC-13: a token with no expiry, or one further away, is ok', () => {
    expect(gitlabTokenStatus(null, null, now)).toBe('ok');
    expect(gitlabTokenStatus(inDays(15), null, now)).toBe('ok');
  });
});
