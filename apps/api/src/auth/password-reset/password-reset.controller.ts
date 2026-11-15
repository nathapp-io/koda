import { Body, Controller, Headers, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { Throttle } from '@nathapp/nestjs-throttler';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { AUTH_LOGIN_LIMIT, AUTH_LOGIN_TTL_MS } from '../auth-throttle';
import { PasswordResetConfirmDto } from '../dto/password-reset-confirm.dto';
import { PasswordResetRequestDto } from '../dto/password-reset-request.dto';
import { PasswordResetService } from './password-reset.service';
import type { EmailLocale } from '../../email/templates/template-codes';

/** Same rule as the module-private `inviteLocale`: only a value starting with `zh` renders Chinese. */
const resetLocale = (acceptLanguage: string | undefined): EmailLocale =>
  acceptLanguage?.trim().toLowerCase().startsWith('zh') ? 'zh' : 'en';

/**
 * auth-passwords US-003/US-004: the password reset surface. Both routes are unauthenticated, so the
 * controller carries no `@ApiBearerAuth` (the same exception `register` and `login` make) and each
 * handler opts out of the global guard with `@Public()` while declaring its own public catalog key.
 *
 * `POST /auth/password-reset` always answers the same 200 `{}` — whether the address has an account,
 * whether the account is disabled, and whether email is configured at all. `POST /auth/password-reset/confirm`
 * answers the same 400 for a dead link and for a disabled account, and issues no session.
 */
@ApiTags('auth')
@Controller('auth')
export class PasswordResetController {
  constructor(private readonly passwordReset: PasswordResetService) {}

  @Post('password-reset')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request a password reset link' })
  @ApiResponse({ status: 200, description: 'Request accepted; the answer never says whether the address has an account' })
  @ApiResponse({ status: 400, description: 'Invalid input' })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  @Public()
  @UseGuards(RequiresGuard)
  @Requires('session.password.reset.request')
  @Throttle({ default: { limit: AUTH_LOGIN_LIMIT, ttl: AUTH_LOGIN_TTL_MS } })
  async requestReset(
    @Body() dto: PasswordResetRequestDto,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    await this.passwordReset.request(dto.email, resetLocale(acceptLanguage));
    return JsonResponse.Ok({});
  }

  /**
   * auth-passwords US-004: consume the emailed token once and write the new password. No session is
   * issued — the client sends the user to the sign-in page — and every failure is the same 400, so the
   * route never says whether a token existed, expired or was already spent.
   */
  @Post('password-reset/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set a new password with a reset token' })
  @ApiResponse({ status: 200, description: 'The password was changed; no session is issued' })
  @ApiResponse({ status: 400, description: 'The reset link is invalid or has expired' })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  @Public()
  @UseGuards(RequiresGuard)
  @Requires('session.password.reset.confirm')
  @Throttle({ default: { limit: AUTH_LOGIN_LIMIT, ttl: AUTH_LOGIN_TTL_MS } })
  async confirmReset(@Body() dto: PasswordResetConfirmDto) {
    await this.passwordReset.confirm(dto, new Date());
    return JsonResponse.Ok({});
  }
}
