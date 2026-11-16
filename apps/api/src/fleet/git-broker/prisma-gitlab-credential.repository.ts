import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, type PrismaClient } from '../../generated/prisma/client';

/**
 * The DI token of the module-private credential repository. The token lives with the repository, so
 * only the git-broker module wires it; `GitBrokerModule` exports the store, never this.
 */
export const GITLAB_CREDENTIAL_REPOSITORY = Symbol('GITLAB_CREDENTIAL_REPOSITORY');

/** Which of a repo's two tokens an operation addresses. */
export type GitLabTokenKind = 'read' | 'write';

/** The stored credential row: the two tokens in ciphertext, their owners and their health. */
export interface GitLabCredentialRow {
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
}

/**
 * One token a save writes: the ciphertext the store produced, the identity its verification found
 * and the expiry GitLab reported. The store encrypts, so the repository never sees a plaintext token.
 */
export interface GitLabCredentialTokenWrite {
  encryptedToken: string;
  userId: number;
  username: string;
  expiresAt: Date | null;
}

/** What a save writes: the project id plus the token kinds it replaces. */
export interface GitLabCredentialWrite {
  gitlabProjectId: number;
  read?: GitLabCredentialTokenWrite;
  write?: GitLabCredentialTokenWrite & { isBot: boolean };
}

/** The persistence the store needs; the only reader and writer of the table. */
export interface IGitLabCredentialRepository {
  findByRepoId(repoId: string): Promise<GitLabCredentialRow | null>;
  /** Stores the credential of a repo, replacing the token kinds the write carries. */
  upsert(repoId: string, write: GitLabCredentialWrite): Promise<void>;
  /** Marks one of the repo's tokens invalid; a repo without a record is left alone. */
  markInvalid(repoId: string, kind: GitLabTokenKind, at: Date): Promise<void>;
}

/**
 * The persistence of the per-repo GitLab credential (GitLab parity F1, US-001).
 *
 * Every call goes through `PrismaService.client`, which is the transaction proxy: a caller that
 * opened a transaction (a registration that inserts the repo and then stores its credential) keeps
 * both writes in that one transaction.
 */
@Injectable()
export class PrismaGitlabCredentialRepository implements IGitLabCredentialRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  async findByRepoId(repoId: string): Promise<GitLabCredentialRow | null> {
    return this.db.fleetRepoGitlabCredential.findUnique({ where: { repoId } });
  }

  /**
   * A new record needs both tokens (the columns are not nullable); an existing one is replaced token
   * by token, so a rotation of the write token keeps the read token and its invalid mark.
   *
   * The invalid mark of a replaced token is cleared: the admin replaced the token, so the old
   * refusal says nothing about the new one. The mark of a token the write does not carry stays.
   */
  async upsert(repoId: string, write: GitLabCredentialWrite): Promise<void> {
    const existing = await this.findByRepoId(repoId);
    if (!existing) {
      const read = write.read;
      const writeToken = write.write;
      if (!read || !writeToken) {
        throw new Error('a new GitLab credential needs both a read and a write token');
      }
      await this.db.fleetRepoGitlabCredential.create({
        data: {
          repoId,
          gitlabProjectId: write.gitlabProjectId,
          encryptedReadToken: read.encryptedToken,
          readTokenUserId: read.userId,
          readTokenUsername: read.username,
          readTokenExpiresAt: read.expiresAt,
          readTokenInvalidAt: null,
          encryptedWriteToken: writeToken.encryptedToken,
          writeTokenUserId: writeToken.userId,
          writeTokenUsername: writeToken.username,
          writeTokenIsBot: writeToken.isBot,
          writeTokenExpiresAt: writeToken.expiresAt,
          writeTokenInvalidAt: null,
        },
      });
      return;
    }

    const data: Prisma.FleetRepoGitlabCredentialUncheckedUpdateInput = { gitlabProjectId: write.gitlabProjectId };
    if (write.read) {
      data.encryptedReadToken = write.read.encryptedToken;
      data.readTokenUserId = write.read.userId;
      data.readTokenUsername = write.read.username;
      data.readTokenExpiresAt = write.read.expiresAt;
      data.readTokenInvalidAt = null;
    }
    if (write.write) {
      data.encryptedWriteToken = write.write.encryptedToken;
      data.writeTokenUserId = write.write.userId;
      data.writeTokenUsername = write.write.username;
      data.writeTokenIsBot = write.write.isBot;
      data.writeTokenExpiresAt = write.write.expiresAt;
      data.writeTokenInvalidAt = null;
    }
    await this.db.fleetRepoGitlabCredential.update({ where: { repoId }, data });
  }

  /** A repo without a credential record has no token to mark, so the write touches no row. */
  async markInvalid(repoId: string, kind: GitLabTokenKind, at: Date): Promise<void> {
    await this.db.fleetRepoGitlabCredential.updateMany({
      where: { repoId },
      data: kind === 'read' ? { readTokenInvalidAt: at } : { writeTokenInvalidAt: at },
    });
  }
}
