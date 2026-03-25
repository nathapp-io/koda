import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { CreateWebhookDto } from './webhook.dto';

@Injectable()
export class WebhookService {
  constructor(private prisma: PrismaService<PrismaClient>) {}
  private get db() { return this.prisma.client; }

  async create(projectId: string, dto: CreateWebhookDto) {
    return this.db.webhook.create({
      data: {
        projectId,
        url: dto.url,
        secret: dto.secret,
        events: JSON.stringify(dto.events),
      },
    });
  }

  async findAll(projectId: string) {
    return this.db.webhook.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findById(id: string) {
    return this.db.webhook.findUnique({ where: { id } });
  }

  async remove(id: string) {
    const webhook = await this.db.webhook.findUnique({ where: { id } });
    if (!webhook) {
      throw new NotFoundAppException();
    }
    await this.db.webhook.delete({ where: { id } });
    return webhook;
  }

  async findByProjectSlug(projectSlug: string) {
    const project = await this.db.project.findUnique({
      where: { slug: projectSlug },
    });
    if (!project || project.deletedAt) {
      throw new NotFoundAppException();
    }
    return this.findAll(project.id);
  }

  async getProjectBySlug(projectSlug: string) {
    const project = await this.db.project.findUnique({
      where: { slug: projectSlug },
    });
    if (!project || project.deletedAt) {
      throw new NotFoundAppException();
    }
    return project;
  }
}
