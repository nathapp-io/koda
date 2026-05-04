import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { OutboxService, OutboxEventData } from './outbox.service';
import { JwtAuthGuard, Principal, RequiredPermission } from '@nathapp/nestjs-auth';
import { KodaPrincipal } from '../auth/principal/koda-principal.types';

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin')
@UseGuards(JwtAuthGuard)
export class AdminController {
  constructor(private readonly outboxService: OutboxService) {}

  @Get('outbox')
  @HttpCode(200)
  @ApiOperation({ summary: 'Get outbox events by status' })
  @ApiResponse({ status: 200, description: 'Returns outbox events' })
  @ApiResponse({ status: 403, description: 'Forbidden - requires admin role' })
  @RequiredPermission('ADMIN')
  async getOutbox(
    @Principal() _principal: KodaPrincipal,
    @Query('status') status?: string,
  ) {
    const events = status
      ? await this.outboxService.getEventsByStatus(status)
      : await this.outboxService.getPendingEvents();
    return {
      items: events,
      total: events.length,
    };
  }

  @Post('outbox/:eventId/retry')
  @HttpCode(200)
  @ApiOperation({ summary: 'Retry a dead-letter outbox event' })
  @ApiResponse({ status: 200, description: 'Event reset to pending' })
  @ApiResponse({ status: 403, description: 'Forbidden - requires admin role' })
  @ApiResponse({ status: 404, description: 'Event not found' })
  @RequiredPermission('ADMIN')
  async retryOutboxEvent(
    @Principal() _principal: KodaPrincipal,
    @Param('eventId') eventId: string,
  ) {
    await this.outboxService.retryEvent(eventId);
  }
}