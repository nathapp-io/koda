import { isDeepStrictEqual } from 'node:util';
import { committedEffect } from '../common/committed-effects';
import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import type { VcsConnectionDomain, VcsConnectionWithProjectDomain } from './domain/vcs.domain';
import { generateWebhookSecret } from './webhook-secret';
import { encryptToken, decryptToken } from '../common/utils/encryption.util';
import { CreateVcsConnectionDto } from './dto/create-vcs-connection.dto';
import { UpdateVcsConnectionDto } from './dto/update-vcs-connection.dto';
import {
  VcsConnectionResponseDto,
  VcsConnectionCreatedResponseDto,
  VcsConnectionUpdatedResponseDto,
  WebhookSecretResponseDto,
} from './dto/vcs-connection-response.dto';
import { TestConnectionResultDto } from './dto/test-connection-result.dto';
import { providerForConnection } from './provider-for-connection';
import { parseRepoPath } from './factory';
import { VcsPollingService } from './vcs-polling.service';
import { IVcsRepository, VCS_REPOSITORY } from './domain/vcs.repository';
import { VCS_CFG, IVcsConfig } from '../config/vcs.config';
import { AuditRecorder } from '../audit/audit-recorder.service';
import { fieldsSummary } from '../audit/audit-summary';
import { AfterCommitService } from '../permissions/after-commit.service';

export function vcsTestTarget(connection: VcsConnectionDomain): Pick<
  VcsConnectionDomain,
  'id' | 'provider' | 'repoOwner' | 'repoName' | 'encryptedToken'
> {
  return {
    id: connection.id,
    provider: connection.provider,
    repoOwner: connection.repoOwner,
    repoName: connection.repoName,
    encryptedToken: connection.encryptedToken,
  };
}

@Injectable()
export class VcsConnectionService {
  private readonly logger = new Logger(VcsConnectionService.name);

  constructor(
    @Inject(VCS_REPOSITORY) private readonly vcsRepo: IVcsRepository,
    @Inject(VCS_CFG) private readonly vcsConfig: IVcsConfig,
    private readonly vcsPollingService: VcsPollingService,
    private readonly audit: AuditRecorder,
    private readonly afterCommit: AfterCommitService,
  ) {}

  /**
   * Create a new VCS connection for a project
   */
  async create(
    projectId: string,
    encryptionKey: string,
    dto: CreateVcsConnectionDto,
  ): Promise<VcsConnectionCreatedResponseDto> {
    // Verify project exists
    const project = await this.vcsRepo.findProjectById(projectId);

    if (!project) {
      throw new NotFoundAppException({}, 'projects');
    }

    // Check if connection already exists
    const existingConnection = await this.vcsRepo.findVcsConnectionByProjectId(projectId);

    if (existingConnection) {
      throw new HttpException('VCS connection already exists for this project', HttpStatus.CONFLICT);
    }

    // Resolve repoOwner and repoName - either from separate fields or parsed from repoUrl
    let repoOwner = dto.repoOwner;
    let repoName = dto.repoName;

    if (dto.repoUrl) {
      const parsed = parseRepoPath(dto.provider, dto.repoUrl);
      if (!parsed) {
        throw new ValidationAppException({}, 'vcs');
      }
      repoOwner = parsed.repoOwner;
      repoName = parsed.repoName;
    }

    if (!repoOwner || !repoName) {
      throw new ValidationAppException({}, 'vcs');
    }

    // Encrypt the token
    const encryptedToken = encryptToken(dto.token, encryptionKey);

    const syncMode = dto.syncMode ?? 'off';
    this.assertSyncModeSupported(dto.provider, syncMode);
    const pollingIntervalMs = dto.pollingIntervalMs ?? this.vcsConfig.defaultPollingIntervalMs;

    // Keep a secret in every mode so late webhook deliveries can be
    // authenticated before the controller acknowledges them as ignored.
    const webhookSecret = generateWebhookSecret();

    const connection = await this.audit.audited(
      () => this.vcsRepo.createVcsConnection({
        projectId,
        provider: dto.provider.toLowerCase(),
        repoOwner,
        repoName,
        encryptedToken,
        syncMode,
        allowedAuthors: JSON.stringify(dto.allowedAuthors ?? []),
        pollingIntervalMs,
        webhookSecret,
        isActive: true,
      }),
      (created) => ({
        key: 'vcs.connection.create',
        resourceType: 'vcs-connection',
        resourceId: created.id,
        projectId,
        summary: `${created.provider} ${created.repoOwner}/${created.repoName}, sync ${created.syncMode}`,
      }),
    );

    await this.refreshAfterCommit(connection.id);

    // M9: besides a rotation, the only time the secret leaves the server.
    return { ...this.mapToResponseDto(connection), webhookSecret };
  }

  /**
   * Get VCS connection for a project
   */
  async findByProject(projectId: string): Promise<VcsConnectionResponseDto> {
    const connection = await this.vcsRepo.findVcsConnectionByProjectId(projectId);

    if (!connection) {
      throw new NotFoundAppException({}, 'vcs');
    }

    return this.mapToResponseDto(connection);
  }

  /**
   * Update VCS connection
   *
   * `connectionId` pins the call to the connection its caller read: a redemption re-reads the project's
   * connection before the gate, so a connection deleted and recreated between approval and redemption
   * answers the new id and never reaches this write (the hashes already differ). This check is the
   * narrower window — a swap between that read and the execution.
   */
  async update(
    projectId: string,
    encryptionKey: string,
    dto: UpdateVcsConnectionDto,
    connectionId?: string,
  ): Promise<VcsConnectionUpdatedResponseDto> {
    // Verify connection exists
    const connection = await this.vcsRepo.findVcsConnectionByProjectId(projectId);

    if (!connection) {
      throw new NotFoundAppException({}, 'vcs');
    }

    if (connectionId !== undefined && connection.id !== connectionId) {
      throw new NotFoundAppException({}, 'vcs');
    }

    if (dto.syncMode) {
      this.assertSyncModeSupported(connection.provider, dto.syncMode);
    }

    const updateData: {
      encryptedToken?: string;
      syncMode?: string;
      allowedAuthors?: string;
      pollingIntervalMs?: number;
      webhookSecret?: string | null;
    } = {};

    // If token is provided, encrypt it
    if (dto.token) {
      updateData.encryptedToken = encryptToken(dto.token, encryptionKey);
    }

    // Update syncMode if provided
    if (dto.syncMode) {
      updateData.syncMode = dto.syncMode;
    }

    if (dto.allowedAuthors !== undefined) {
      updateData.allowedAuthors = JSON.stringify(dto.allowedAuthors);
    }

    if (dto.pollingIntervalMs !== undefined) {
      updateData.pollingIntervalMs = dto.pollingIntervalMs;
    }

    // Generate a secret when enabling webhooks on a legacy row, and keep it
    // when switching away so senders can sign in-flight deliveries while sync
    // is off or polling. A generated secret is returned once (M9).
    const generatedSecret = dto.syncMode === 'webhook' && !connection.webhookSecret
      ? generateWebhookSecret()
      : undefined;
    if (generatedSecret) {
      updateData.webhookSecret = generatedSecret;
    }

    // Only update if there are changes
    if (Object.keys(updateData).length === 0) {
      return this.mapToResponseDto(connection);
    }

    const { encryptedToken: token, ...updateFields } = updateData;
    const updated = await this.audit.audited(
      () => this.vcsRepo.updateVcsConnection(projectId, updateData),
      (result) => ({
        key: 'vcs.connection.update',
        resourceType: 'vcs-connection',
        resourceId: result.id,
        projectId,
        summary: fieldsSummary({ ...updateFields, ...(token === undefined ? {} : { token }) }),
      }),
    );

    await this.refreshAfterCommit(updated.id);

    const response = this.mapToResponseDto(updated);
    return generatedSecret ? { ...response, webhookSecret: generatedSecret } : response;
  }

  /**
   * `gate-secret` (US-002): schedules the connection's polling after the write that produced it committed.
   *
   * Inside an approval redemption the write runs in the engine's transaction, and the scheduler reads the
   * row through its own connection: refreshing before the commit schedules a row nobody can see yet. So the
   * refresh is deferred to the transaction owner's after-commit queue, exactly as a permission-cache
   * invalidation is. Outside any scope (`defer` answers false) there is nothing to wait for and today's
   * inline refresh — and today's error propagation — stands.
   *
   * The deferred task is warning-only: the connection is already durable, and a failed schedule refresh must
   * not turn an executed redemption into a 500 that loses the one-time `webhookSecret`.
   */
  private async refreshAfterCommit(connectionId: string): Promise<void> {
    const deferred = this.afterCommit.defer(async () => {
      try {
        await this.vcsPollingService.refreshConnectionSchedule(connectionId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`VCS polling refresh failed for connection ${connectionId}: ${message}`);
      }
    });
    if (!deferred) await this.vcsPollingService.refreshConnectionSchedule(connectionId);
  }

  /**
   * Delete VCS connection
   */
  async delete(projectId: string): Promise<void> {
    const connection = await this.vcsRepo.findVcsConnectionByProjectId(projectId);

    if (!connection) {
      throw new NotFoundAppException({}, 'vcs');
    }

    await this.audit.audited(
      () => this.vcsRepo.deleteVcsConnection(projectId),
      () => ({
        key: 'vcs.connection.delete',
        resourceType: 'vcs-connection',
        resourceId: connection.id,
        projectId: connection.projectId,
        summary: `deleted ${connection.provider} ${connection.repoOwner}/${connection.repoName}`,
      }),
    );

    committedEffect(() => this.vcsPollingService.unschedulePolling(connection.id));
  }

  /**
   * M9: replace the inbound webhook secret and return the new one, once.
   * Deliveries signed with the old secret are rejected from now on.
   *
   * `connectionId` pins the rotation to the connection its caller read before the gate, the same way
   * `update` does: a recreated connection answers a different stored input and is never touched.
   */
  async rotateWebhookSecret(projectId: string, connectionId?: string): Promise<WebhookSecretResponseDto> {
    const connection = await this.vcsRepo.findVcsConnectionByProjectId(projectId);

    if (!connection) {
      throw new NotFoundAppException({}, 'vcs');
    }

    if (connectionId !== undefined && connection.id !== connectionId) {
      throw new NotFoundAppException({}, 'vcs');
    }

    const webhookSecret = generateWebhookSecret();
    await this.audit.audited(
      () => this.vcsRepo.updateVcsConnection(projectId, { webhookSecret }),
      (updated) => ({
        key: 'vcs.webhook-secret.rotate',
        resourceType: 'vcs-connection',
        resourceId: updated.id,
        projectId: updated.projectId,
        summary: 'webhook secret rotated',
      }),
    );
    return { webhookSecret };
  }

  /** Provider HTTP is outside the approval transaction; settlement rechecks the tested target. */
  async prepareTestConnection(projectId: string, encryptionKey: string): Promise<() => Promise<TestConnectionResultDto>> {
    const connection = await this.vcsRepo.findVcsConnectionByProjectId(projectId);
    if (!connection) throw new NotFoundAppException({}, 'vcs');
    const result = await this.testTarget(connection, encryptionKey);
    return async () => {
      const current = await this.vcsRepo.findVcsConnectionByProjectId(projectId);
      if (!isDeepStrictEqual(current && vcsTestTarget(current), vcsTestTarget(connection))) {
        throw new ValidationAppException({}, 'vcs');
      }
      return result;
    };
  }

  /**
   * Test connection to the VCS service
   */
  async testConnection(
    projectId: string,
    encryptionKey: string,
  ): Promise<TestConnectionResultDto> {
    const connection = await this.vcsRepo.findVcsConnectionByProjectId(projectId);

    if (!connection) {
      throw new NotFoundAppException({}, 'vcs');
    }

    return this.testTarget(connection, encryptionKey);
  }

  private async testTarget(connection: VcsConnectionDomain, encryptionKey: string): Promise<TestConnectionResultDto> {
    const startTime = Date.now();

    // Decrypt the token
    let decryptedToken: string;
    try {
      decryptedToken = decryptToken(connection.encryptedToken, encryptionKey);
    } catch {
      throw new ValidationAppException({}, 'vcs');
    }

    // Create provider and test connection
    try {
      const provider = providerForConnection(connection, decryptedToken, this.vcsConfig);

      const result = await provider.testConnection();
      const latencyMs = Date.now() - startTime;
      return result.ok
        ? { ok: true, latencyMs }
        : { ok: false, latencyMs, error: result.error };
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        ok: false,
        latencyMs,
        error: errorMessage,
      };
    }
  }

  /**
   * Get full connection for internal use (includes encryptedToken).
   * Deferred apply uses lock to keep target validation and writes in the same caller transaction.
   */
  async getFullByProject(projectId: string, options?: { lock: boolean }): Promise<VcsConnectionDomain> {
    const connection = options?.lock
      ? await this.vcsRepo.findVcsConnectionByProjectId(projectId, options)
      : await this.vcsRepo.findVcsConnectionByProjectId(projectId);

    if (!connection) {
      throw new NotFoundAppException({}, 'vcs');
    }

    return connection;
  }

  /**
   * The connection (with its project) that receives inbound webhooks for
   * `slug`, or null when the slug is unknown, the project is soft-deleted, or it
   * has no connection. Never throws NotFound: the webhook route answers every
   * miss with the same 401.
   */
  async findInboundTarget(slug: string): Promise<VcsConnectionWithProjectDomain | null> {
    return this.vcsRepo.findVcsConnectionByProjectSlug(slug);
  }

  /**
   * Map VcsConnectionDomain to response DTO (excludes encryptedToken and
   * webhookSecret: the secret leaves the server only in the create/update/rotate
   * responses that produced it (M9).
   */
  private mapToResponseDto(connection: VcsConnectionDomain): VcsConnectionResponseDto {
    return {
      id: connection.id,
      projectId: connection.projectId,
      provider: connection.provider,
      repoOwner: connection.repoOwner,
      repoName: connection.repoName,
      syncMode: connection.syncMode,
      allowedAuthors: this.parseAllowedAuthors(connection.allowedAuthors),
      pollingIntervalMs: connection.pollingIntervalMs,
      webhookSecretConfigured: connection.webhookSecret !== null && connection.webhookSecret !== undefined,
      lastSyncedAt: connection.lastSyncedAt?.toISOString() ?? null,
      isActive: connection.isActive,
      createdAt: connection.createdAt.toISOString(),
      updatedAt: connection.updatedAt.toISOString(),
    };
  }

  private parseAllowedAuthors(allowedAuthors: string): string[] {
    try {
      const parsed = JSON.parse(allowedAuthors) as unknown;
      return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
    } catch {
      return [];
    }
  }

  /**
   * BUG-14: GitLab is polling + outbound only. Inbound GitLab webhooks are out of
   * scope (Track 3 ruling 2026-09-27), so webhook mode is refused up front
   * rather than accepted and then ignored on every delivery.
   */
  private assertSyncModeSupported(provider: string, syncMode: string): void {
    if (provider.toLowerCase() === 'gitlab' && syncMode === 'webhook') {
      throw new ValidationAppException({}, 'vcs.gitlabWebhook');
    }
  }
}
