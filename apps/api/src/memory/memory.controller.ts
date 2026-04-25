import { Controller, Post, Body, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ExtractionService } from './extraction.service';
import { MemoryItemRepository } from './memory-item-repository';
import { MemoryKind } from '../common/enums';

interface MemoryWriteInput {
  projectId: string;
  kind: MemoryKind;
  subject: string;
  predicate: string;
  object?: string;
  sourceType?: string;
  sourceId?: string;
  confidence?: number;
}

interface CurrentUser {
  id?: string;
  sub?: string;
  extra?: {
    sub?: string;
    email?: string;
    role?: string;
    actorType?: string;
  };
  actorType?: string;
}

interface PrismaDelegate {
  findUnique(options: { where: Record<string, unknown>; select?: unknown; include?: unknown }): Promise<unknown>
}

interface ExtendedPrismaClient {
  project: PrismaDelegate
  [key: string]: unknown
}

@ApiTags('memory')
@ApiBearerAuth()
@Controller('memory')
export class MemoryController {
  constructor(
    private readonly extractionService: ExtractionService,
    private readonly repository: MemoryItemRepository,
    private readonly prisma: PrismaService,
  ) {}

  private get db() {
    return this.prisma.client as unknown as ExtendedPrismaClient;
  }

  private getActorRole(currentUser: CurrentUser | null): string | null {
    if (!currentUser) return null;
    if (currentUser.extra?.role) return currentUser.extra.role;
    if (currentUser.actorType === 'agent') return 'AGENT';
    return null;
  }

  private async validateProjectAccess(projectId: string, currentUser: CurrentUser): Promise<void> {
    if (!currentUser) throw new ForbiddenAppException({}, 'memory');

    const role = this.getActorRole(currentUser);
    if (!role) throw new ForbiddenAppException({}, 'memory');

    if (!['ADMIN', 'DEVELOPER', 'AGENT'].includes(role)) {
      throw new ForbiddenAppException({ code: 'ACCESS_DENIED' }, 'memory');
    }

    const project = await this.db.project.findUnique({
      where: { id: projectId },
    });

    if (!project) {
      throw new ForbiddenAppException({ code: 'PROJECT_NOT_FOUND' }, 'memory');
    }
  }

  @Post('extract')
  @ApiOperation({ summary: 'Extract memory items from an event' })
  @ApiResponse({ status: 201, description: 'Memory items extracted' })
  @ApiResponse({ status: 403, description: 'Access denied' })
  async extractFromEvent(@Body() event: unknown, @Req() req: { user?: CurrentUser }) {
    const currentUser = req.user ?? null;
    const eventWithProject = event as { projectId?: string };

    if (eventWithProject.projectId) {
      await this.validateProjectAccess(eventWithProject.projectId, currentUser as CurrentUser);
    }

    const items = this.extractionService.extractFromEvent(event as Parameters<typeof this.extractionService.extractFromEvent>[0]);

    for (const item of items) {
      await this.repository.upsert({
        ...item,
        sourceType: item.sourceType || (event as { type?: string }).type,
        sourceId: item.sourceId || (event as { id?: string }).id,
      });
    }

    return items;
  }

  @Post('decisions')
  @ApiOperation({ summary: 'Record a decision' })
  @ApiResponse({ status: 201, description: 'Decision recorded' })
  @ApiResponse({ status: 403, description: 'Access denied' })
  async recordDecision(
    @Body() decision: { projectId: string; agentId: string; decision: string; rationale?: string },
    @Req() req: { user?: CurrentUser },
  ) {
    const currentUser = req.user ?? null;
    const role = this.getActorRole(currentUser);

    if (!role || !['ADMIN', 'DEVELOPER', 'AGENT'].includes(role)) {
      throw new ForbiddenAppException({ code: 'ACCESS_DENIED' }, 'memory');
    }

    return this.extractionService.recordDecision(
      decision,
      { id: `event-${Date.now()}` },
      this.repository,
    );
  }
}