import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { VcsConnection } from '@prisma/client';
import { randomBytes } from 'crypto';
import { encryptToken, decryptToken } from '../common/utils/encryption.util';
import { CreateVcsConnectionDto } from './dto/create-vcs-connection.dto';
import { UpdateVcsConnectionDto } from './dto/update-vcs-connection.dto';
import { VcsConnectionResponseDto } from './dto/vcs-connection-response.dto';
import { createVcsProvider } from './factory';
import { VcsPollingService } from './vcs-polling.service';

// PrismaClientLike from @nathapp/nestjs-prisma doesn't expose VCS models,
// but they exist at runtime. Define a delegate interface for proper typing.
interface PrismaDelegate {
  findUnique(options: { where: Record<string, unknown>; select?: unknown; include?: unknown }): Promise<unknown>
  findMany(options?: unknown): Promise<unknown[]>
  findFirst(options?: unknown): Promise<unknown>
  create(options: { data: unknown; select?: unknown; include?: unknown }): Promise<unknown>
  update(options: { where: Record<string, unknown>; data: unknown; select?: unknown; include?: unknown }): Promise<unknown>
  delete(options: { where: Record<string, unknown>; select?: unknown; include?: unknown }): Promise<unknown>
}

interface ExtendedPrismaClient {
  project: PrismaDelegate
  vcsConnection: PrismaDelegate
  [key: string]: unknown
}

@Injectable()
export class VcsConnectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly vcsPollingService: VcsPollingService,
  ) {}

  private get db() {
    return this.prisma.client as unknown as ExtendedPrismaClient;
  }

  /**
   * Create a new VCS connection for a project
   */
  async create(
    projectId: string,
    encryptionKey: string,
    dto: CreateVcsConnectionDto,
  ): Promise<VcsConnectionResponseDto> {
    // Verify project exists
    const project = await this.db.project.findUnique({
      where: { id: projectId },
    });

    if (!project) {
      throw new NotFoundAppException({}, 'projects');
    }

    // Check if connection already exists
    const existingConnection = await this.db.vcsConnection.findUnique({
      where: { projectId },
    });

    if (existingConnection) {
      throw new ValidationAppException({}, 'vcs');
    }

    // Encrypt the token
    const encryptedToken = encryptToken(dto.token, encryptionKey);

    const syncMode = dto.syncMode ?? 'off';
    const pollingIntervalMs =
      dto.pollingIntervalMs
      ?? this.configService.get<number>('vcs.defaultPollingIntervalMs')
      ?? 600000;

    // Create connection
    const connection = (await this.db.vcsConnection.create({
      data: {
        projectId,
        provider: dto.provider.toLowerCase(),
        repoOwner: dto.repoOwner,
        repoName: dto.repoName,
        encryptedToken,
        syncMode,
        allowedAuthors: JSON.stringify(dto.allowedAuthors ?? []),
        pollingIntervalMs,
        webhookSecret: syncMode === 'webhook' ? randomBytes(16).toString('hex') : null,
        isActive: true,
      },
    })) as VcsConnection;

    await this.vcsPollingService.refreshConnectionSchedule(connection.id);

    return this.mapToResponseDto(connection);
  }

  /**
   * Get VCS connection for a project
   */
  async findByProject(projectId: string): Promise<VcsConnectionResponseDto> {
    const connection = (await this.db.vcsConnection.findUnique({
      where: { projectId },
    })) as VcsConnection | null;

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
    const connection = (await this.db.vcsConnection.findUnique({
      where: { projectId },
    })) as VcsConnection | null;

    if (!connection) {
      throw new NotFoundAppException({}, 'vcs');
    }

    const updateData: Record<string, unknown> = {};

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

    const updated = (await this.db.vcsConnection.update({
      where: { projectId },
      data: updateData,
    })) as VcsConnection;

    await this.vcsPollingService.refreshConnectionSchedule(updated.id);

    return this.mapToResponseDto(updated);
  }

  /**
   * Delete VCS connection
   */
  async delete(projectId: string): Promise<void> {
    const connection = (await this.db.vcsConnection.findUnique({
      where: { projectId },
    })) as VcsConnection | null;

    if (!connection) {
      throw new NotFoundAppException({}, 'vcs');
    }

    await this.db.vcsConnection.delete({
      where: { projectId },
    });

    this.vcsPollingService.unschedulePolling(connection.id);
  }

  /**
   * Test connection to the VCS service
   */
  async testConnection(
    projectId: string,
    encryptionKey: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const connection = (await this.db.vcsConnection.findUnique({
      where: { projectId },
    })) as VcsConnection | null;

    if (!connection) {
      throw new NotFoundAppException({}, 'vcs');
    }

    // Decrypt the token
    let decryptedToken: string;
    try {
      decryptedToken = decryptToken(connection.encryptedToken, encryptionKey);
    } catch (error) {
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
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        ok: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Get full connection for internal use (includes encryptedToken)
   */
  async getFullByProject(projectId: string): Promise<VcsConnection> {
    const connection = (await this.db.vcsConnection.findUnique({
      where: { projectId },
    })) as VcsConnection | null;

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
      provider: connection.provider,
      repoOwner: connection.repoOwner,
      repoName: connection.repoName,
      syncMode: connection.syncMode,
      allowedAuthors: this.parseAllowedAuthors(connection.allowedAuthors),
      pollingIntervalMs: connection.pollingIntervalMs,
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
}
