import { Controller, Delete, Get, Param, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { ForbiddenAppException, JsonResponse } from '@nathapp/nestjs-common';
import { isUserPrincipal, KodaPrincipal, UserPrincipal } from '../auth/principal/koda-principal.types';
import { CurrentProject } from '../projects/current-project.decorator';
import type { ProjectContext } from '../projects/project-context';
import { ProjectMembershipGuard } from '../projects/project-membership.guard';
import { WatchStateDto } from './dto/watch-state.dto';
import { TicketWatchService } from './ticket-watch.service';

function caller(principal: KodaPrincipal): UserPrincipal {
  if (!principal || !isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'notifications');
  return principal;
}

/** Fleet S4a §3: watch / unwatch a ticket (any project member; users only). */
@ApiTags('notifications')
@ApiBearerAuth()
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@ApiParam({ name: 'ref', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/tickets/:ref')
@UseGuards(ProjectMembershipGuard)
export class TicketWatchController {
  constructor(private readonly service: TicketWatchService) {}

  @Get('watchers')
  @ApiOperation({ summary: 'Whether I watch this ticket, and how many people do' })
  @ApiResponse({ status: 200, type: WatchStateDto })
  @ApiResponse({ status: 404, description: 'Ticket not found' })
  async state(@Param('ref') ref: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.service.state(ctx.project.id, ref, caller(principal).id));
  }

  @Put('watch')
  @ApiOperation({ summary: 'Watch this ticket (receive its activity notifications)' })
  @ApiResponse({ status: 200, type: WatchStateDto })
  @ApiResponse({ status: 404, description: 'Ticket not found' })
  async watch(@Param('ref') ref: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.service.watch(ctx.project.id, ref, caller(principal).id));
  }

  @Delete('watch')
  @ApiOperation({ summary: 'Stop watching this ticket; assignments and mentions still notify' })
  @ApiResponse({ status: 200, type: WatchStateDto })
  @ApiResponse({ status: 404, description: 'Ticket not found' })
  async unwatch(@Param('ref') ref: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.service.unwatch(ctx.project.id, ref, caller(principal).id));
  }
}
