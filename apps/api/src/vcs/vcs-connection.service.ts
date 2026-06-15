import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { VcsConnection } from '@prisma/client';
import { randomBytes } from 'crypto';
import { encryptToken, decryptToken } from '../common/utils/encryption.util';
import { CreateVcsConnectionDto } from './dto/create-vcs-connection.dto';
import { UpdateVcsConnectionDto } from './dto/update-vcs-connection.dto';
import { VcsConnectionResponseDto } from './dto/vcs-connection-response.dto';
import { TestConnectionResultDto } from './dto/test-connection-result.dto';
import { createVcsProvider } from './factory';
import { VcsPollingService } from './vcs-polling.service';
import { IVcsRepository, VCS_REPOSITORY } from './domain/vcs.repository';

@Injectable()
export class VcsConnectionService {
  constructor(
    @Inject(VCS_REPOSITORY) private readonly vcsRepo: IVcsRepository,
    private readonly configService: ConfigService,
    private readonly vcsPollingService: VcsPollingService,
  ) {}

  /**
   * Create a new VCS connection for a project
   */
  async create(
    projectId: string,
    encryptionKey: string,
    dto: CreateVcsConnectionDto,
  ): Promise<VcsConnectionResponseDto> {
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
      const parsed = this.parseRepoUrl(dto.repoUrl);
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
    const pollingIntervalMs =
      dto.pollingIntervalMs
      ?? this.configService.get<number>('vcs.defaultPollingIntervalMs')
      ?? 600000;

    const connection = await this.vcsRepo.createVcsConnection({
      projectId,
      provider: dto.provider.toLowerCase(),
      repoOwner,
      repoName,
      encryptedToken,
      syncMode,
      allowedAuthors: JSON.stringify(dto.allowedAuthors ?? []),
      pollingIntervalMs,
      webhookSecret: syncMode === 'webhook' ? randomBytes(16).toString('hex') : null,
      isActive: true,
    });

    await this.vcsPollingService.refreshConnectionSchedule(connection.id);

    return this.mapToResponseDto(connection);
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
   */
  async update(
    projectId: string,
    encryptionKey: string,
    dto: UpdateVcsConnectionDto,
  ): Promise<VcsConnectionResponseDto> {
    // Verify connection exists
    const connection = await this.vcsRepo.findVcsConnectionByProjectId(projectId);

    if (!connection) {
      throw new NotFoundAppException({}, 'vcs');
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

    if (dto.syncMode === 'webhook') {
      updateData.webhookSecret = connection.webhookSecret ?? randomBytes(16).toString('hex');
    }

    if (dto.syncMode && dto.syncMode !== 'webhook') {
      updateData.webhookSecret = null;
    }

    // Only update if there are changes
    if (Object.keys(updateData).length === 0) {
      return this.mapToResponseDto(connection);
    }

    const updated = await this.vcsRepo.updateVcsConnection(projectId, updateData);

    await this.vcsPollingService.refreshConnectionSchedule(updated.id);

    return this.mapToResponseDto(updated);
  }

  /**
   * Delete VCS connection
   */
  async delete(projectId: string): Promise<void> {
    const connection = await this.vcsRepo.findVcsConnectionByProjectId(projectId);

    if (!connection) {
      throw new NotFoundAppException({}, 'vcs');
    }

    await this.vcsRepo.deleteVcsConnection(projectId);

    this.vcsPollingService.unschedulePolling(connection.id);
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
      const provider = createVcsProvider(connection.provider, {
        provider: connection.provider,
        token: decryptedToken,
        repoUrl: `https://github.com/${connection.repoOwner}/${connection.repoName}`,
      });

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
   * Get full connection for internal use (includes encryptedToken)
   */
  async getFullByProject(projectId: string): Promise<VcsConnection> {
    const connection = await this.vcsRepo.findVcsConnectionByProjectId(projectId);

    if (!connection) {
      throw new NotFoundAppException({}, 'vcs');
    }

    return connection;
  }

  /**
   * Map Prisma VcsConnection to response DTO (excludes encryptedToken)
   */
  private mapToResponseDto(connection: VcsConnection): VcsConnectionResponseDto {
    return {
      id: connection.id,
      projectId: connection.projectId,
      provider: connection.provider,
      repoOwner: connection.repoOwner,
      repoName: connection.repoName,
      syncMode: connection.syncMode,
      allowedAuthors: this.parseAllowedAuthors(connection.allowedAuthors),
      pollingIntervalMs: connection.pollingIntervalMs,
      webhookSecret: connection.webhookSecret,
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

  private parseRepoUrl(repoUrl: string): { repoOwner: string; repoName: string } | null {
    const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (!match) {
      return null;
    }
    return { repoOwner: match[1], repoName: match[2].replace(/\.git$/, '') };
  }
}
