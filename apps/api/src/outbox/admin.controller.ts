import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { OutboxAdminService } from './outbox-admin.service';
import { OutboxListQueryDto } from './dto/outbox-list-query.dto';
import { JwtAuthGuard, Principal, RequiredPermission } from '@nathapp/nestjs-auth';
import { KodaPrincipal } from '../auth/principal/koda-principal.types';

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin')
@UseGuards(JwtAuthGuard)
export class AdminController {
  constructor(private readonly outboxAdmin: OutboxAdminService) {}

  @Get('outbox')
  @HttpCode(200)
  @ApiOperation({ summary: 'Get outbox events by status' })
  @ApiResponse({ status: 200, description: 'Returns outbox events' })
  @ApiResponse({ status: 403, description: 'Forbidden - requires admin role' })
  @ApiResponse({ status: 400, description: 'Unknown status' })
  @RequiredPermission('ADMIN')
  async getOutbox(
    @Principal() _principal: KodaPrincipal,
    @Query() query: OutboxListQueryDto,
  ) {
    return this.outboxAdmin.list(query.status);
  }

  @Post('outbox/:eventId/retry')
  @HttpCode(200)
  @ApiOperation({ summary: 'Retry a dead outbox event' })
  @ApiResponse({ status: 200, description: 'Event reset to pending' })
  @ApiResponse({ status: 403, description: 'Forbidden - requires admin role' })
  @ApiResponse({ status: 404, description: 'Event not found' })
  @ApiResponse({ status: 409, description: 'Event is processing or already published' })
  @RequiredPermission('ADMIN')
  async retryOutboxEvent(
    @Principal() _principal: KodaPrincipal,
    @Param('eventId') eventId: string,
  ) {
    await this.outboxAdmin.retry(eventId);
  }
}
