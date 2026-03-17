import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  Req,
  ForbiddenException,
  HttpCode,
} from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { IsPublic } from '../auth/decorators/is-public.decorator';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RequestWithUser = any & { user?: { role: string } };

@ApiTags('projects')
@ApiBearerAuth()
@Controller('projects')
export class ProjectsController {
  constructor(private projectsService: ProjectsService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a new project (admin only)' })
  @ApiResponse({ status: 201, description: 'Project created successfully' })
  @ApiResponse({ status: 400, description: 'Invalid request data' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  @ApiResponse({ status: 409, description: 'Conflict - duplicate slug or key' })
  async create(
    @Body() createProjectDto: CreateProjectDto,
    @Req() req: RequestWithUser,
  ) {
    // Check if user is admin
    if (req.user?.role !== 'ADMIN') {
      throw new ForbiddenException('Admin role required');
    }

    return this.projectsService.create(createProjectDto);
  }

  @Get()
  @IsPublic()
  @ApiOperation({ summary: 'List all projects (excluding soft-deleted)' })
  @ApiResponse({ status: 200, description: 'List of projects' })
  async findAll() {
    return this.projectsService.findAll();
  }

  @Get(':slug')
  @IsPublic()
  @ApiOperation({ summary: 'Get a project by slug' })
  @ApiResponse({ status: 200, description: 'Project found' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async findBySlug(@Param('slug') slug: string) {
    return this.projectsService.findBySlug(slug);
  }

  @Patch(':slug')
  @UseGuards(JwtAuthGuard)
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
    @Req() req: RequestWithUser,
  ) {
    // Check if user is admin
    if (req.user?.role !== 'ADMIN') {
      throw new ForbiddenException('Admin role required');
    }

    return this.projectsService.update(slug, updateProjectDto);
  }

  @Delete(':slug')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Soft delete a project (admin only)' })
  @ApiResponse({ status: 200, description: 'Project soft deleted successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async remove(
    @Param('slug') slug: string,
    @Req() req: RequestWithUser,
  ) {
    // Check if user is admin
    if (req.user?.role !== 'ADMIN') {
      throw new ForbiddenException('Admin role required');
    }

    return this.projectsService.softDelete(slug);
  }
}
