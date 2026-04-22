import { Controller, Get, HttpCode, UseGuards } from '@nestjs/common';
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
  @ApiOperation({ summary: 'Get pending outbox events' })
  @ApiResponse({ status: 200, description: 'Returns pending outbox events' })
  @ApiResponse({ status: 403, description: 'Forbidden - requires admin role' })
  async getOutbox(@CurrentUser() currentUser: AdminUser) {
    if (currentUser?.extra?.role !== 'ADMIN') {
      throw new ForbiddenAppException({}, 'admin');
    }
    const events = await this.outboxService.getPendingEvents();
    return {
      items: events,
      total: events.length,
    };
  }
}