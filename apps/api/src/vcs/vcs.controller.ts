import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Param,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Principal } from '@nathapp/nestjs-auth';
import { ConfigService } from '@nestjs/config';
import { VcsConnectionService } from './vcs-connection.service';
import { ProjectsService } from '../projects/projects.service';
import { CreateVcsConnectionDto } from './dto/create-vcs-connection.dto';
import { UpdateVcsConnectionDto } from './dto/update-vcs-connection.dto';
import { VcsConnectionResponseDto } from './dto/vcs-connection-response.dto';
import { TestConnectionResultDto } from './dto/test-connection-result.dto';

@Controller('/projects/:slug/vcs')
export class VcsController {
  constructor(
    private readonly vcsService: VcsConnectionService,
    private readonly projectsService: ProjectsService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * POST /projects/:slug/vcs
   * Create a new VCS connection for a project
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createConnection(
    @Param('slug') slug: string,
    @Body() dto: CreateVcsConnectionDto,
    @Principal('userId') userId?: string,
  ): Promise<VcsConnectionResponseDto> {
    // Get project by slug
    const project = await this.projectsService.findBySlug(slug);

    // Get encryption key from config
    const encryptionKey = this.configService.get<string>('vcs.encryptionKey');
    if (!encryptionKey) {
      throw new Error('VCS encryption key not configured');
    }

    return this.vcsService.create(project.id, encryptionKey, dto);
  }

  /**
   * GET /projects/:slug/vcs
   * Get VCS connection for a project
   */
  @Get()
  async getConnection(
    @Param('slug') slug: string,
    @Principal('userId') userId?: string,
  ): Promise<VcsConnectionResponseDto> {
    // Get project by slug
    const project = await this.projectsService.findBySlug(slug);

    return this.vcsService.findByProject(project.id);
  }

  /**
   * PATCH /projects/:slug/vcs
   * Update VCS connection for a project
   */
  @Patch()
  async updateConnection(
    @Param('slug') slug: string,
    @Body() dto: UpdateVcsConnectionDto,
    @Principal('userId') userId?: string,
  ): Promise<VcsConnectionResponseDto> {
    // Get project by slug
    const project = await this.projectsService.findBySlug(slug);

    // Get encryption key from config
    const encryptionKey = this.configService.get<string>('vcs.encryptionKey');
    if (!encryptionKey) {
      throw new Error('VCS encryption key not configured');
    }

    return this.vcsService.update(project.id, encryptionKey, dto);
  }

  /**
   * DELETE /projects/:slug/vcs
   * Delete VCS connection for a project
   */
  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteConnection(
    @Param('slug') slug: string,
    @Principal('userId') userId?: string,
  ): Promise<void> {
    // Get project by slug
    const project = await this.projectsService.findBySlug(slug);

    return this.vcsService.delete(project.id);
  }

  /**
   * POST /projects/:slug/vcs/test
   * Test the VCS connection
   */
  @Post('/test')
  async testConnection(
    @Param('slug') slug: string,
    @Principal('userId') userId?: string,
  ): Promise<TestConnectionResultDto> {
    // Get project by slug
    const project = await this.projectsService.findBySlug(slug);

    // Get encryption key from config
    const encryptionKey = this.configService.get<string>('vcs.encryptionKey');
    if (!encryptionKey) {
      throw new Error('VCS encryption key not configured');
    }

    const result = await this.vcsService.testConnection(project.id, encryptionKey);

    return {
      success: result.success,
      latencyMs: result.latencyMs,
      error: result.error,
    };
  }
}
