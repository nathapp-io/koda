import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
} from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { GetProjectMemoryDto, ProjectMemoryResponseDto } from './dto/project-memory.dto';
import { JsonResponse } from '@nathapp/nestjs-common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiQuery,
} from '@nestjs/swagger';
import { MemoryItemRepository } from '../memory/memory-item-repository';

@ApiTags('projects')
@ApiBearerAuth()
@Controller('projects')
export class ProjectsController {
  constructor(
    private projectsService: ProjectsService,
    private memoryItemRepository: MemoryItemRepository,
  ) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a new project (admin only)' })
  @ApiResponse({ status: 201, description: 'Project created successfully' })
  @ApiResponse({ status: 400, description: 'Invalid request data' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  @ApiResponse({ status: 409, description: 'Conflict - duplicate slug or key' })
  async create(@Body() createProjectDto: CreateProjectDto) {
    const data = await this.projectsService.create(createProjectDto);
    return JsonResponse.Ok(data);
  }

  @Get()
  @ApiOperation({ summary: 'List all projects (excluding soft-deleted)' })
  @ApiResponse({ status: 200, description: 'List of projects' })
  async findAll() {
    const data = await this.projectsService.findAll();
    return JsonResponse.Ok(data);
  }

  @Get(':slug')
  @ApiOperation({ summary: 'Get a project by slug' })
  @ApiResponse({ status: 200, description: 'Project found' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async findBySlug(@Param('slug') slug: string) {
    const data = await this.projectsService.findBySlug(slug);
    return JsonResponse.Ok(data);
  }

  @Patch(':slug')
  @ApiOperation({ summary: 'Update a project (admin only)' })
  @ApiResponse({ status: 200, description: 'Project updated successfully' })
  @ApiResponse({ status: 400, description: 'Invalid request data' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @ApiResponse({ status: 409, description: 'Conflict - duplicate slug or key' })
  async update(
    @Param('slug') slug: string,
    @Body() updateProjectDto: UpdateProjectDto,
  ) {
    const data = await this.projectsService.update(slug, updateProjectDto);
    return JsonResponse.Ok(data);
  }

  @Delete(':slug')
  @ApiOperation({ summary: 'Soft delete a project (admin only)' })
  @ApiResponse({ status: 200, description: 'Project soft deleted successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async remove(@Param('slug') slug: string) {
    const data = await this.projectsService.softDelete(slug);
    return JsonResponse.Ok(data);
  }

  @Get(':slug/memory')
  @ApiOperation({ summary: 'Get project semantic memories' })
  @ApiResponse({ status: 200, description: 'Project memories retrieved', type: ProjectMemoryResponseDto })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @ApiQuery({ name: 'kind', required: false, enum: ['FACT', 'INCIDENT_PATTERN', 'DECISION'] })
  @ApiQuery({ name: 'subjects', required: false, description: 'Filter by subject prefix' })
  @ApiQuery({ name: 'status', required: false, description: 'Filter by status (active, superseded, rejected)' })
  async getProjectMemory(@Param('slug') slug: string, @Query() query: GetProjectMemoryDto) {
    const project = await this.projectsService.findBySlug(slug);

    const result = await this.memoryItemRepository.findByProjectMemory({
      projectId: project.id,
      kind: query.kind,
      subject: query.subjects,
      status: query.status,
    });

    return JsonResponse.Ok({
      total: result.total,
      items: result.items.map((item) => ({
        id: item.id,
        projectId: item.projectId,
        kind: item.kind,
        subject: item.subject,
        predicate: item.predicate,
        object: item.object,
        confidence: item.confidence,
        supersededBy: item.supersededBy,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      })),
    });
  }
}
