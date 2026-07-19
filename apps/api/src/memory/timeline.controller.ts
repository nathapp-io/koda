import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JsonResponse, ValidationAppException } from '@nathapp/nestjs-common';
import { TimelineService } from './timeline.service';
import { ProjectAccessService } from '../projects/project-access.service';

@ApiTags('memory')
@ApiBearerAuth()
@Controller('projects/:slug/timeline')
export class TimelineController {
  constructor(
    private readonly timelineService: TimelineService,
    private readonly projectAccess: ProjectAccessService,
  ) {}

  private async resolveProject(slug: string): Promise<{ id: string }> {
    const id = await this.projectAccess.findProjectIdBySlug(slug);
    return { id };
  }

  private parseDate(value?: string): Date | undefined {
    if (!value) return undefined;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new ValidationAppException({ date: 'Invalid date' });
    }
    return parsed;
  }

  private parseEventTypes(value?: string | string[]): string[] | undefined {
    if (!value) return undefined;
    const raw = Array.isArray(value) ? value : value.split(',');
    const eventTypes = raw.map((entry) => entry.trim()).filter(Boolean);
    return eventTypes.length > 0 ? eventTypes : undefined;
  }

  private parseLimit(value?: string): number | undefined {
    if (!value) return undefined;
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) {
      throw new ValidationAppException({ limit: 'Invalid limit' });
    }
    return parsed;
  }

  @Get()
  @ApiOperation({ summary: 'Get a project timeline' })
  @ApiResponse({ status: 200, description: 'Project timeline' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async getTimeline(
    @Param('slug') slug: string,
    @Query('actorId') actorId?: string,
    @Query('ticketId') ticketId?: string,
    @Query('eventTypes') eventTypes?: string | string[],
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const project = await this.resolveProject(slug);
    const fromDate = this.parseDate(from);
    const toDate = this.parseDate(to);

    if (fromDate && toDate && fromDate > toDate) {
      throw new ValidationAppException({ from: 'from must be before to' });
    }

    const data = await this.timelineService.getProjectTimeline({
      projectId: project.id,
      actorId,
      ticketId,
      eventTypes: this.parseEventTypes(eventTypes),
      from: fromDate,
      to: toDate,
      limit: this.parseLimit(limit),
      cursor,
    });

    return JsonResponse.Ok(data);
  }
}
