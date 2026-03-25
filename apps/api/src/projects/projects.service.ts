import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { ValidationAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';

@Injectable()
export class ProjectsService {
  constructor(private prisma: PrismaService<PrismaClient>) {}
  private get db() { return this.prisma.client; }


  async create(createProjectDto: CreateProjectDto) {
    // --- DEBUG LOG (E2E) ---
    console.log('[E2E-DEBUG] createProject received:', JSON.stringify(createProjectDto));

    // Validate name
    if (createProjectDto.name.length < 2) {
      console.log('[E2E-DEBUG] THROW: name.length < 2');
      throw new ValidationAppException();
    }

    // Validate slug format (lowercase alphanumeric and hyphens only)
    const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
    if (!slugPattern.test(createProjectDto.slug)) {
      console.log('[E2E-DEBUG] THROW: slug pattern failed — slug:', createProjectDto.slug);
      throw new ValidationAppException();
    }

    // Validate key format (2-6 uppercase letters only)
    const keyPattern = /^[A-Z]{2,6}$/;
    if (!keyPattern.test(createProjectDto.key)) {
      console.log('[E2E-DEBUG] THROW: key pattern failed — key:', createProjectDto.key);
      throw new ValidationAppException();
    }

    // Check slug uniqueness
    const existingSlug = await this.db.project.findUnique({
      where: { slug: createProjectDto.slug },
    });
    if (existingSlug) {
      console.log('[E2E-DEBUG] THROW: existingSlug conflict — slug:', createProjectDto.slug);
      throw new ValidationAppException();
    }

    // Check key uniqueness
    const existingKey = await this.db.project.findUnique({
      where: { key: createProjectDto.key },
    });
    if (existingKey) {
      console.log('[E2E-DEBUG] THROW: existingKey conflict — key:', createProjectDto.key);
      throw new ValidationAppException();
    }

    console.log('[E2E-DEBUG] All validations passed, creating project with:', JSON.stringify(createProjectDto));

    // Create project
    return this.db.project.create({
      data: {
        name: createProjectDto.name,
        slug: createProjectDto.slug,
        key: createProjectDto.key,
        description: createProjectDto.description,
        gitRemoteUrl: createProjectDto.gitRemoteUrl,
        autoIndexOnClose: createProjectDto.autoIndexOnClose ?? true,
        autoAssign: createProjectDto.autoAssign ?? 'OFF'
      },
    });
  }
