import { Inject, Injectable } from '@nestjs/common';
import { decryptToken, encryptToken } from '../../common/utils/encryption.util';
import { IVcsConfig, VCS_CFG } from '../../config/vcs.config';
import { RepoCheckException } from './repo-check.exception';
import { DEFAULT_GITLAB_HOST } from './gitlab-host';
import {
  GITLAB_CREDENTIAL_REPOSITORY,
  type GitLabTokenKind,
  type IGitLabCredentialRepository,
} from './prisma-gitlab-credential.repository';

/**
 * The access one GitLab call gets: the token to present and the target to address. The target is
 * the repo's own host and its numeric GitLab project id — never an owner/name pair, because two
 * hosts can hold the same path.
 */
export interface GitLabAccess {
  token: string;
  target: { apiBase: string; projectId: number };
}

/** One token a save stores: the plaintext token and the identity its verification found. */
export interface GitLabCredentialTokenInput {
  token: string;
  userId: number;
  username: string;
  expiresAt: Date | null;
}

/**
 * What a save stores: the GitLab project id plus the token kinds it replaces. Either token may be
 * absent on a rotation; a first save needs both.
 */
export interface GitLabCredentialInput {
  gitlabProjectId: number;
  read?: GitLabCredentialTokenInput;
  write?: GitLabCredentialTokenInput & { isBot: boolean };
}

/** The host a repo without one is addressed at. */
export { DEFAULT_GITLAB_HOST };

/** The api base of a repo: its own host, or gitlab.com when the row carries none. */
const apiBaseFor = (host: string | undefined): string =>
  `${host !== undefined && host.trim() !== '' ? host : DEFAULT_GITLAB_HOST}/api/v4`;

/** A token that expires within this window is reported as expiring. */
const TOKEN_EXPIRING_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * The health of one stored token: `invalid` when it was refused, `expiring` when it runs out
 * within a fortnight, `ok` otherwise. Pure, so the projection and the store agree.
 */
export function gitlabTokenStatus(
  expiresAt: Date | null,
  invalidAt: Date | null,
  now: Date,
): 'ok' | 'invalid' | 'expiring' {
  if (invalidAt !== null) return 'invalid';
  if (expiresAt !== null && expiresAt.getTime() - now.getTime() <= TOKEN_EXPIRING_WINDOW_MS) return 'expiring';
  return 'ok';
}

/**
 * The store of the per-repo GitLab connection (GitLab parity F1, US-001).
 *
 * It is the only reader and writer of the credential table: the tokens are encrypted here, under
 * `VCS_ENCRYPTION_KEY`, so neither the row nor a log line ever holds a plaintext token. A repo
 * without a record is "not connected" — there is no fallback to another repo's token.
 */
@Injectable()
export class GitLabRepoCredentials {
  constructor(
    @Inject(GITLAB_CREDENTIAL_REPOSITORY) private readonly repository: IGitLabCredentialRepository,
    @Inject(VCS_CFG) private readonly vcsConfig: Pick<IVcsConfig, 'encryptionKey'>,
  ) {}

  /** The configured key, or the refusal a caller gets without one. */
  private encryptionKey(): string {
    this.assertKeyConfigured();
    return this.vcsConfig.encryptionKey as string;
  }

  /** Refuses a deployment without `VCS_ENCRYPTION_KEY`: no token can be read or written without it. */
  assertKeyConfigured(): void {
    if (!this.vcsConfig.encryptionKey) throw new RepoCheckException('vcs_encryption_key_missing');
  }

  /**
   * Stores a repo's credential, replacing the token kinds the input carries and keeping the rest.
   * The invalid mark of a replaced token is cleared: the admin replaced the token, so the old
   * refusal says nothing about the new one.
   */
  async save(repoId: string, input: GitLabCredentialInput): Promise<void> {
    const key = this.encryptionKey();
    await this.repository.upsert(repoId, {
      gitlabProjectId: input.gitlabProjectId,
      read: input.read === undefined ? undefined : {
        encryptedToken: encryptToken(input.read.token, key),
        userId: input.read.userId,
        username: input.read.username,
        expiresAt: input.read.expiresAt,
      },
      write: input.write === undefined ? undefined : {
        encryptedToken: encryptToken(input.write.token, key),
        userId: input.write.userId,
        username: input.write.username,
        expiresAt: input.write.expiresAt,
        isBot: input.write.isBot,
      },
    });
  }

  /**
   * The access one of a repo's tokens gives. A repo without a record has no access, and a token
   * that does not decrypt under the configured key is refused as invalid.
   */
  async resolve(repo: { id: string; host?: string }, kind: GitLabTokenKind): Promise<GitLabAccess> {
    const key = this.encryptionKey();
    const row = await this.repository.findByRepoId(repo.id);
    if (!row) throw new RepoCheckException('gitlab_credentials_missing');
    const encrypted = kind === 'read' ? row.encryptedReadToken : row.encryptedWriteToken;
    let token: string;
    try {
      token = decryptToken(encrypted, key);
    } catch {
      throw new RepoCheckException('gitlab_token_invalid');
    }
    return {
      token,
      target: { apiBase: apiBaseFor(repo.host), projectId: row.gitlabProjectId },
    };
  }

  /**
   * Runs a GitLab call with one of the repo's tokens. A call refused as `gitlab_token_invalid`
   * marks that token invalid before the refusal is rethrown; every other failure leaves the
   * tokens as they were.
   */
  async call<T>(
    repo: { id: string; host?: string },
    kind: GitLabTokenKind,
    fn: (access: GitLabAccess) => Promise<T>,
  ): Promise<T> {
    const access = await this.resolve(repo, kind);
    try {
      return await fn(access);
    } catch (error) {
      if (error instanceof RepoCheckException && error.reason === 'gitlab_token_invalid') {
        await this.markInvalid(repo.id, kind);
      }
      throw error;
    }
  }

  /**
   * Marks one of a repo's tokens invalid. The mark is sticky: only a save that replaces the token
   * clears it, because a later success does not make the old refusal untrue — the admin is
   * expected to rotate the token.
   */
  async markInvalid(repoId: string, kind: GitLabTokenKind): Promise<void> {
    await this.repository.markInvalid(repoId, kind, new Date());
  }
}
