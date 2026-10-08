import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JsonResponse } from '@nathapp/nestjs-common';
import { Public } from '@nathapp/nestjs-auth';
import { Throttle } from '@nathapp/nestjs-throttler';
import { AUTH_LOGIN_LIMIT, AUTH_LOGIN_TTL_MS } from '../../auth/auth-throttle';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { InvitePreviewDto } from './dto/invite-preview.dto';
import { AuthResponseDto } from '../../auth/dto/auth-response.dto';
import { InviteAcceptanceService } from './invite-acceptance.service';

/**
 * Fleet S4b US-005: the anonymous invite routes. Both are `@Public()` and carry register's
 * brute-force throttle — an unauthenticated visitor may hold nothing but the raw token.
 */
@ApiTags('invites')
@Controller('invites')
export class PublicInvitesController {
  constructor(private readonly acceptance: InviteAcceptanceService) {}

  @Get(':token')
  @Public()
  @Throttle({ default: { limit: AUTH_LOGIN_LIMIT, ttl: AUTH_LOGIN_TTL_MS } })
  @ApiOperation({ summary: 'Preview an invite token (anonymous)' })
  @ApiResponse({ status: 200, type: InvitePreviewDto })
  @ApiResponse({ status: 404, description: 'Unknown, expired, cancelled or accepted token' })
  async preview(@Param('token') token: string) {
    return JsonResponse.Ok(await this.acceptance.preview(token));
  }

  @Post(':token/accept')
  @HttpCode(201)
  @Public()
  @Throttle({ default: { limit: AUTH_LOGIN_LIMIT, ttl: AUTH_LOGIN_TTL_MS } })
  @ApiOperation({ summary: 'Accept an invite, creating the account and issuing a session (anonymous)' })
  @ApiResponse({ status: 201, type: AuthResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid name or password' })
  @ApiResponse({ status: 404, description: 'Unknown, expired or already redeemed token' })
  @ApiResponse({ status: 409, description: 'An account already exists for the invited address' })
  async accept(@Param('token') token: string, @Body() dto: AcceptInviteDto) {
    return JsonResponse.Ok(await this.acceptance.accept(token, dto));
  }
}
