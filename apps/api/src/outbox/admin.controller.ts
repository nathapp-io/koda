import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { OutboxService, OutboxEventData } from './outbox.service';
import { JwtAuthGuard } from '@nathapp/nestjs-auth';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

type AdminUser = { extra?: { role?: string } } | null;

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
  async getOutbox(
    @CurrentUser() currentUser: AdminUser,
    @Query('status') status?: string,
  ) {
    if (currentUser?.extra?.role !== 'ADMIN') {
      throw new ForbiddenAppException({}, 'admin');
    }
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
  async retryOutboxEvent(
    @CurrentUser() currentUser: AdminUser,
    @Param('eventId') eventId: string,
  ) {
    if (currentUser?.extra?.role !== 'ADMIN') {
      throw new ForbiddenAppException({}, 'admin');
    }
    await this.outboxService.retryEvent(eventId);
  }
}