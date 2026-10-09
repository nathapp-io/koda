import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ForbiddenAppException, JsonResponse } from '@nathapp/nestjs-common';
import { Principal } from '@nathapp/nestjs-auth';
import { isUserPrincipal, KodaPrincipal, UserPrincipal } from '../auth/principal/koda-principal.types';
import { parseQuery } from '../common/dto/koda-page.query';
import { ListNotificationsQuery } from './dto/list-notifications.query';
import { NotificationPageDto, UnreadCountDto } from './dto/notification.dto';
import { NotificationPreferencesDto, NotificationPreferencesViewDto } from './dto/notification-preferences.dto';
import { MeNotificationsService } from './me-notifications.service';
import { NotificationPreferencesService } from './notification-preferences.service';

function caller(principal: KodaPrincipal): UserPrincipal {
  if (!principal || !isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'notifications');
  return principal;
}

/** Fleet S4a §3: the signed-in user's inbox and preferences. Users only; never takes a user id. */
@ApiTags('notifications')
@ApiBearerAuth()
@Controller('me')
export class MeNotificationsController {
  constructor(
    private readonly notifications: MeNotificationsService,
    private readonly preferences: NotificationPreferencesService,
  ) {}

  @Get('notifications')
  @ApiOperation({ summary: 'My notifications, newest first (users only)' })
  @ApiResponse({ status: 200, type: NotificationPageDto })
  @ApiResponse({ status: 403, description: 'Agents and runners have no inbox' })
  async list(@Query() rawQuery: ListNotificationsQuery, @Principal() principal: KodaPrincipal) {
    const me = caller(principal);
    const { current, size, unread } = parseQuery(ListNotificationsQuery, rawQuery);
    return JsonResponse.Ok(await this.notifications.list(me.id, { current, size, unreadOnly: unread === 'true' }));
  }

  @Get('notifications/unread-count')
  @ApiOperation({ summary: 'How many of my notifications are unread' })
  @ApiResponse({ status: 200, type: UnreadCountDto })
  async unreadCount(@Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.notifications.unreadCount(caller(principal).id));
  }

  @Post('notifications/:id/read')
  @HttpCode(204)
  @ApiOperation({ summary: 'Mark one of my notifications read (idempotent)' })
  @ApiResponse({ status: 204, description: 'Read' })
  @ApiResponse({ status: 404, description: 'No such notification of mine' })
  async markRead(@Param('id') id: string, @Principal() principal: KodaPrincipal): Promise<void> {
    await this.notifications.markRead(caller(principal).id, id);
  }

  @Post('notifications/read-all')
  @HttpCode(204)
  @ApiOperation({ summary: 'Mark every notification I had when this request arrived read' })
  @ApiResponse({ status: 204, description: 'Read' })
  async markAllRead(@Principal() principal: KodaPrincipal): Promise<void> {
    const me = caller(principal);
    await this.notifications.markAllRead(me.id, new Date());
  }

  @Get('notification-preferences')
  @ApiOperation({ summary: 'My in-app and email notification categories' })
  @ApiResponse({ status: 200, type: NotificationPreferencesViewDto })
  async getPreferences(@Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.preferences.list(caller(principal).id));
  }

  @Put('notification-preferences')
  @ApiOperation({ summary: 'Switch my notification categories and email on or off' })
  @ApiResponse({ status: 200, type: NotificationPreferencesViewDto })
  @ApiResponse({ status: 400, description: 'Unknown category or malformed body' })
  async updatePreferences(@Body() dto: NotificationPreferencesDto, @Principal() principal: KodaPrincipal) {
    const me = caller(principal);
    await this.preferences.update(me.id, { emailEnabled: dto.emailEnabled, items: dto.items });
    return JsonResponse.Ok(await this.preferences.list(me.id));
  }
}
