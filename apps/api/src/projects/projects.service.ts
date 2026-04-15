import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { ValidationAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { ProjectResponseDto } from './dto/project-response.dto';

@Injectable()
export class ProjectsService {
  constructor(private prisma: PrismaService<PrismaClient>) {}
  private get db() { return this.prisma.client; }


  async create(createProjectDto: CreateProjectDto) {
    // Validate name
    if (createProjectDto.name.length < 2) {
      throw new ValidationAppException({}, 'projects');
    }

    // Validate slug format (lowercase alphanumeric and hyphens only)
    const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
    if (!slugPattern.test(createProjectDto.slug)) {
      throw new ValidationAppException({}, 'projects');
    }

    // Validate key format (2-6 uppercase letters only)
    const keyPattern = /^[A-Z]{2,6}$/;
    if (!keyPattern.test(createProjectDto.key)) {
      throw new ValidationAppException({}, 'projects');
    }

    // Check slug uniqueness
    const existingSlug = await this.db.project.findUnique({
      where: { slug: createProjectDto.slug },
    });
    if (existingSlug) {
      throw new ValidationAppException({}, 'projects');
    }

    // Check key uniqueness
    const existingKey = await this.db.project.findUnique({
      where: { key: createProjectDto.key },
    });
    if (existingKey) {
      throw new ValidationAppException({}, 'projects');
    }

    // Create project
    return ProjectResponseDto.from(await this.db.project.create({
      data: {
        name: createProjectDto.name,
        slug: createProjectDto.slug,
        key: createProjectDto.key,
        description: createProjectDto.description,
        gitRemoteUrl: createProjectDto.gitRemoteUrl,
        autoIndexOnClose: createProjectDto.autoIndexOnClose ?? true,
        autoAssign: createProjectDto.autoAssign ?? 'OFF'
      },
    }));
  }

  async findAll() {
    return ProjectResponseDto.fromMany(await this.db.project.findMany({
      where: {
        deletedAt: null,
      },
    }));
  }

  async findBySlug(slug: string) {
    const project = await this.db.project.findUnique({
      where: { slug },
    });

    // Filter out soft-deleted projects
    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'projects');
    }

    return ProjectResponseDto.from(project);
  }

  async update(slug: string, updateProjectDto: UpdateProjectDto) {
    // Find the current project
    const currentProject = await this.db.project.findUnique({
      where: { slug },
    });

    if (!currentProject) {
      throw new NotFoundAppException({}, 'projects');
    }

    // Validate name if provided
    if (updateProjectDto.name !== undefined && updateProjectDto.name.length < 2) {
      throw new ValidationAppException({}, 'projects');
    }

    // Validate slug format if provided (lowercase alphanumeric and hyphens only)
    if (updateProjectDto.slug !== undefined) {
      const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
      if (!slugPattern.test(updateProjectDto.slug)) {
        throw new ValidationAppException({}, 'projects');
      }

      // Check slug uniqueness (unless it's the same as current)
      if (updateProjectDto.slug !== currentProject.slug) {
        const existingSlug = await this.db.project.findUnique({
          where: { slug: updateProjectDto.slug },
        });
        if (existingSlug && existingSlug.id !== currentProject.id) {
          throw new ValidationAppException({}, 'projects');
        }
      }
    }

    // Validate key format if provided (2-6 uppercase letters only)
    if (updateProjectDto.key !== undefined) {
      const keyPattern = /^[A-Z]{2,6}$/;
      if (!keyPattern.test(updateProjectDto.key)) {
        throw new ValidationAppException({}, 'projects');
      }

      // Check key uniqueness (unless it's the same as current)
      if (updateProjectDto.key !== currentProject.key) {
        const existingKey = await this.db.project.findUnique({
          where: { key: updateProjectDto.key },
        });
        if (existingKey && existingKey.id !== currentProject.id) {
          throw new ValidationAppException({}, 'projects');
        }
      }
    }

    // Update project
    return ProjectResponseDto.from(await this.db.project.update({
      where: { slug },
      data: {
        name: updateProjectDto.name,
        slug: updateProjectDto.slug,
        key: updateProjectDto.key,
        description: updateProjectDto.description,
        gitRemoteUrl: updateProjectDto.gitRemoteUrl,
        autoIndexOnClose: updateProjectDto.autoIndexOnClose,
        autoAssign: updateProjectDto.autoAssign,
        ciWebhookToken: updateProjectDto.ciWebhookToken,
        graphifyEnabled: updateProjectDto.graphifyEnabled,
      },
    }));
  }

  async softDelete(slug: string) {
    // Find the project
    const project = await this.db.project.findUnique({
      where: { slug },
    });

    if (!project) {
      throw new NotFoundAppException({}, 'projects');
    }

    // Soft delete by setting deletedAt
    return ProjectResponseDto.from(await this.db.project.update({
      where: { slug },
      data: {
        deletedAt: new Date(),
      },
    }));
  }
}
