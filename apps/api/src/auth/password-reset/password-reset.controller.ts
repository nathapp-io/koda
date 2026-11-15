import { Body, Controller, Headers, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { Throttle } from '@nathapp/nestjs-throttler';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { AUTH_LOGIN_LIMIT, AUTH_LOGIN_TTL_MS } from '../auth-throttle';
import { PasswordResetRequestDto } from '../dto/password-reset-request.dto';
import { PasswordResetService } from './password-reset.service';
import type { EmailLocale } from '../../email/templates/template-codes';

/** Same rule as the module-private `inviteLocale`: only a value starting with `zh` renders Chinese. */
const resetLocale = (acceptLanguage: string | undefined): EmailLocale =>
  acceptLanguage?.trim().toLowerCase().startsWith('zh') ? 'zh' : 'en';

/**
 * auth-passwords US-003: the password reset surface. Both routes are unauthenticated, so the
 * controller carries no `@ApiBearerAuth` (the same exception `register` and `login` make) and each
 * handler opts out of the global guard with `@Public()` while declaring its own public catalog key.
 *
 * `POST /auth/password-reset` always answers the same 200 `{}` — whether the address has an account,
 * whether the account is disabled, and whether email is configured at all.
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
}
