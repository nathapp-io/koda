import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';

@Injectable()
export class ProjectsService {
  constructor(private prisma: PrismaService) {}

  async create(createProjectDto: CreateProjectDto) {
    // Validate name
    if (createProjectDto.name.length < 2) {
      throw new BadRequestException('Name must be at least 2 characters long');
    }

    // Validate slug format
    const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
    if (!slugPattern.test(createProjectDto.slug)) {
      throw new BadRequestException(
        'Slug must contain only lowercase alphanumeric characters and hyphens',
      );
    }

    // Validate key format
    const keyPattern = /^[A-Z0-9]{2,6}$/;
    if (!keyPattern.test(createProjectDto.key)) {
      throw new BadRequestException(
        'Key must be 2-6 uppercase alphanumeric characters',
      );
    }

    // Check slug uniqueness
    const existingSlug = await this.prisma.project.findUnique({
      where: { slug: createProjectDto.slug },
    });
    if (existingSlug) {
      throw new ConflictException('Slug already exists');
    }

    // Check key uniqueness
    const existingKey = await this.prisma.project.findUnique({
      where: { key: createProjectDto.key },
    });
    if (existingKey) {
      throw new ConflictException('Key already exists');
    }

    // Create project
    return this.prisma.project.create({
      data: {
        name: createProjectDto.name,
        slug: createProjectDto.slug,
        key: createProjectDto.key,
        description: createProjectDto.description,
        gitRemoteUrl: createProjectDto.gitRemoteUrl,
        autoIndexOnClose: createProjectDto.autoIndexOnClose ?? true,
      },
    });
  }

  async findAll() {
    return this.prisma.project.findMany({
      where: {
        deletedAt: null,
      },
    });
  }

  async findBySlug(slug: string) {
    const project = await this.prisma.project.findUnique({
      where: { slug },
    });

    // Filter out soft-deleted projects
    if (project && project.deletedAt) {
      return null;
    }

    return project;
  }

  async update(slug: string, updateProjectDto: UpdateProjectDto) {
    // Find the current project
    const currentProject = await this.prisma.project.findUnique({
      where: { slug },
    });

    if (!currentProject) {
      throw new NotFoundException('Project not found');
    }

    // Validate name if provided
    if (updateProjectDto.name !== undefined && updateProjectDto.name.length < 2) {
      throw new BadRequestException('Name must be at least 2 characters long');
    }

    // Validate slug format if provided
    if (updateProjectDto.slug !== undefined) {
      const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
      if (!slugPattern.test(updateProjectDto.slug)) {
        throw new BadRequestException(
          'Slug must contain only lowercase alphanumeric characters and hyphens',
        );
      }

      // Check slug uniqueness (unless it's the same as current)
      if (updateProjectDto.slug !== currentProject.slug) {
        const existingSlug = await this.prisma.project.findUnique({
          where: { slug: updateProjectDto.slug },
        });
        if (existingSlug) {
          throw new ConflictException('Slug already exists');
        }
      }
    }

    // Validate key format if provided
    if (updateProjectDto.key !== undefined) {
      const keyPattern = /^[A-Z0-9]{2,6}$/;
      if (!keyPattern.test(updateProjectDto.key)) {
        throw new BadRequestException(
          'Key must be 2-6 uppercase alphanumeric characters',
        );
      }

      // Check key uniqueness (unless it's the same as current)
      if (updateProjectDto.key !== currentProject.key) {
        const existingKey = await this.prisma.project.findUnique({
          where: { key: updateProjectDto.key },
        });
        if (existingKey) {
          throw new ConflictException('Key already exists');
        }
      }
    }

    // Update project
    return this.prisma.project.update({
      where: { slug },
      data: {
        name: updateProjectDto.name,
        slug: updateProjectDto.slug,
        key: updateProjectDto.key,
        description: updateProjectDto.description,
        gitRemoteUrl: updateProjectDto.gitRemoteUrl,
        autoIndexOnClose: updateProjectDto.autoIndexOnClose,
      },
    });
  }

  async softDelete(slug: string) {
    // Find the project
    const project = await this.prisma.project.findUnique({
      where: { slug },
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    // Soft delete by setting deletedAt
    return this.prisma.project.update({
      where: { slug },
      data: {
        deletedAt: new Date(),
      },
    });
  }
}
