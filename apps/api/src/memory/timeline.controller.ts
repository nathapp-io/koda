import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JsonResponse, ValidationAppException } from '@nathapp/nestjs-common';
import { TimelineService, MAX_TIMELINE_LIMIT } from './timeline.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { ProjectMembershipGuard } from '../projects/project-membership.guard';
import { Requires } from '../permissions/requires.decorator';
import { RequiresGuard } from '../permissions/requires.guard';

/**
 * The project timeline (permissions P1 US-008).
 *
 * `ProjectMembershipGuard, RequiresGuard` in one `@UseGuards` resolves `request.projectContext` — and refuses a
 * non-member — before `timeline.read` is checked, so the handler no longer asserts membership itself and needs no
 * principal of its own. `timeline.read` is a `*.read` grant a Viewer holds; the handler still resolves the slug,
 * which answers 404 for an unknown or soft-deleted project.
 */
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
    if (value === undefined || value === '') return undefined;
    const parsed = /^\d+$/.test(value) ? Number(value) : NaN;
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_TIMELINE_LIMIT) {
      throw new ValidationAppException({ limit: `limit must be an integer between 1 and ${MAX_TIMELINE_LIMIT}` });
    }
    return parsed;
  }

  @Get()
  @UseGuards(ProjectMembershipGuard, RequiresGuard)
  @Requires('timeline.read')
  @ApiOperation({ summary: 'Get a project timeline (timeline.read)' })
  @ApiResponse({ status: 200, description: 'Project timeline' })
  @ApiResponse({ status: 403, description: 'timeline.read is missing, or the caller is not a member' })
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
