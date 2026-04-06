import { Injectable } from '@nestjs/common';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { VcsConnection } from '@prisma/client';
import { encryptToken, decryptToken } from '../common/utils/encryption.util';
import { CreateVcsConnectionDto } from './dto/create-vcs-connection.dto';
import { UpdateVcsConnectionDto } from './dto/update-vcs-connection.dto';
import { VcsConnectionResponseDto } from './dto/vcs-connection-response.dto';
import { createVcsProvider } from './factory';

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
  constructor(private readonly prisma: PrismaService) {}

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
      throw new ValidationAppException({}, 'vcs_connections');
    }

    // Encrypt the token
    const encryptedToken = encryptToken(dto.token, encryptionKey);

    // Parse repo URL to extract owner and name
    const urlMatch = dto.repoUrl?.match(/github\.com\/([^/]+)\/([^/]+)/) || [];
    const repoOwner = urlMatch[1];
    const repoName = urlMatch[2];

    if (!repoOwner || !repoName) {
      throw new ValidationAppException({}, 'vcs_connections');
    }

    // Create connection
    const connection = (await this.db.vcsConnection.create({
      data: {
        projectId,
        provider: dto.provider.toLowerCase(),
        repoOwner,
        repoName,
        encryptedToken,
        syncMode: dto.syncMode || 'polling',
        allowedAuthors: '[]',
        pollingIntervalMs: 3600000,
        webhookSecret: dto.webhookSecret,
        isActive: true,
      },
    })) as VcsConnection;

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
      throw new NotFoundAppException({}, 'vcs_connections');
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
      throw new NotFoundAppException({}, 'vcs_connections');
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

    // Update webhookSecret if provided
    if (dto.webhookSecret !== undefined) {
      updateData.webhookSecret = dto.webhookSecret;
    }

    // Only update if there are changes
    if (Object.keys(updateData).length === 0) {
      return this.mapToResponseDto(connection);
    }

    const updated = (await this.db.vcsConnection.update({
      where: { projectId },
      data: updateData,
    })) as VcsConnection;

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
      throw new NotFoundAppException({}, 'vcs_connections');
    }

    await this.db.vcsConnection.delete({
      where: { projectId },
    });
  }

  /**
   * Test connection to the VCS service
   */
  async testConnection(
    projectId: string,
    encryptionKey: string,
  ): Promise<{ success: boolean; latencyMs: number; error?: string }> {
    const connection = (await this.db.vcsConnection.findUnique({
      where: { projectId },
    })) as VcsConnection | null;

    if (!connection) {
      throw new NotFoundAppException({}, 'vcs_connections');
    }

    // Decrypt the token
    let decryptedToken: string;
    try {
      decryptedToken = decryptToken(connection.encryptedToken, encryptionKey);
    } catch (error) {
      return {
        success: false,
        latencyMs: 0,
        error: 'Failed to decrypt token',
      };
    }

    // Create provider and test connection
    const startTime = Date.now();

    try {
      const provider = createVcsProvider(connection.provider, {
        provider: connection.provider,
        token: decryptedToken,
        repoUrl: `https://github.com/${connection.repoOwner}/${connection.repoName}`,
      });

      const result = await provider.testConnection();
      const latencyMs = Date.now() - startTime;

      if (result.ok) {
        return {
          success: true,
          latencyMs,
        };
      } else {
        return {
          success: false,
          latencyMs,
          error: result.error,
        };
      }
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        latencyMs,
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
      throw new NotFoundAppException({}, 'vcs_connections');
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
      allowedAuthors: connection.allowedAuthors,
      pollingIntervalMs: connection.pollingIntervalMs,
      webhookSecret: connection.webhookSecret ?? undefined,
      lastSyncedAt: connection.lastSyncedAt ?? undefined,
      isActive: connection.isActive,
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
    };
  }
}
