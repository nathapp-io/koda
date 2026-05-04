import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { OutboxService, OutboxEventData } from './outbox.service';
import { JwtAuthGuard, Principal, RequiredPermission } from '@nathapp/nestjs-auth';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import { KodaPrincipal } from '../auth/principal/koda-principal.types';

type LegacyPrincipal = { authorities?: unknown[]; extra?: { role?: string } } | null;

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin')
@UseGuards(JwtAuthGuard)
export class AdminController {
  constructor(private readonly outboxService: OutboxService) {}

  private ensureAdmin(principal: KodaPrincipal | LegacyPrincipal): void {
    const isAdmin = Boolean(
      principal?.authorities?.some((authority) => String(authority) === 'ADMIN') ||
      principal?.extra?.role === 'ADMIN',
    );
    if (!isAdmin) {
      throw new ForbiddenAppException({}, 'admin');
    }
  }

  @Get('outbox')
  @HttpCode(200)
  @ApiOperation({ summary: 'Get outbox events by status' })
  @ApiResponse({ status: 200, description: 'Returns outbox events' })
  @ApiResponse({ status: 403, description: 'Forbidden - requires admin role' })
  @RequiredPermission('ADMIN')
  async getOutbox(
    @Principal() principal: KodaPrincipal | LegacyPrincipal,
    @Query('status') status?: string,
  ) {
    this.ensureAdmin(principal);
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
    @Principal() principal: KodaPrincipal | LegacyPrincipal,
    @Param('eventId') eventId: string,
  ) {
    this.ensureAdmin(principal);
    await this.outboxService.retryEvent(eventId);
  }
}