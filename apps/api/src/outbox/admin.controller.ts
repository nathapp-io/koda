import { Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { ApprovalGated } from '../approvals/route/approval-gated.decorator';
import { ApprovalPending } from '../approvals/route/approval-pending';
import { ApprovalRouteGate } from '../approvals/route/approval-route-gate';
import { OUTBOX_ROUTE_VARIANTS } from './outbox-route.commands';
import { OutboxAdminService } from './outbox-admin.service';
import { OutboxStatus } from '@nathapp/nestjs-outbox';
import { OutboxListQueryDto } from './dto/outbox-list-query.dto';
import { JwtAuthGuard, Principal } from '@nathapp/nestjs-auth';
import { Requires } from '../permissions/requires.decorator';
import { RequiresGuard } from '../permissions/requires.guard';
import { KodaPrincipal } from '../auth/principal/koda-principal.types';

// Permissions P1 (US-010): a global route with no project slug, so each handler states its catalog
// key and the guard list carries `RequiresGuard` next to the JwtAuthGuard this controller already
// had. `outbox.*` are GLOBAL-scope role keys, so a project-admin binding does not satisfy them.
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin')
@UseGuards(JwtAuthGuard, RequiresGuard)
export class AdminController {
  constructor(private readonly outboxAdmin: OutboxAdminService, private readonly routeGate: ApprovalRouteGate) {}

  @Get('outbox')
  @HttpCode(200)
  @Requires('outbox.read')
  @ApiOperation({ summary: 'Get outbox events by status' })
  @ApiResponse({ status: 200, description: 'Returns outbox events' })
  @ApiResponse({ status: 403, description: 'Forbidden - outbox.read is missing' })
  @ApiResponse({ status: 400, description: 'Unknown status' })
  async getOutbox(
    @Principal() _principal: KodaPrincipal,
    @Query() query: OutboxListQueryDto,
  ) {
    // @IsEnum(OutboxStatus) on the DTO has validated the value.
    return this.outboxAdmin.list(query.status as OutboxStatus | undefined);
  }

  @Post('outbox/:eventId/retry')
  @ApprovalGated()
  @HttpCode(200)
  @Requires('outbox.retry')
  @ApiOperation({ summary: 'Retry a dead outbox event' })
  @ApiResponse({ status: 200, description: 'Event reset to pending' })
  @ApiResponse({ status: 403, description: 'Forbidden - outbox.retry is missing' })
  @ApiResponse({ status: 404, description: 'Event not found' })
  @ApiResponse({ status: 409, description: 'Event is processing or already published' })
  async retryOutboxEvent(
    @Principal() _principal: KodaPrincipal,
    @Param('eventId') eventId: string,
  ) {
    const outcome = await this.routeGate.run({
      key: 'outbox.retry', variant: OUTBOX_ROUTE_VARIANTS.retry, projectId: null, input: { eventId },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
  }
}
