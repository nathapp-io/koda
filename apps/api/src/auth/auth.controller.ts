import {
  Controller,
  Post,
  Get,
  Body,
  HttpCode,
  HttpStatus,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { AuthResponseDto, UserResponseDto } from './dto/auth-response.dto';
import { RegistrationStatusDto } from './dto/registration-status.dto';
import { Public, Principal, JwtRefreshGuard } from '@nathapp/nestjs-auth';
import type { IPrincipal } from './types';
import { Throttle } from '@nathapp/nestjs-throttler';
import { AuthException, JsonResponse } from '@nathapp/nestjs-common';
import { Requires } from '../permissions/requires.decorator';
import { RequiresGuard } from '../permissions/requires.guard';
import { AUTH_LOGIN_LIMIT, AUTH_LOGIN_TTL_MS } from './auth-throttle';
import { KodaPrincipal, isUserPrincipal } from './principal/koda-principal.types';
import { refreshClientFrom, type RefreshRequestLike } from './sessions/refresh-client';

/**
 * Permissions P1 (US-010): every auth route states its catalog key. The four session-starting routes
 * declare a public key, so `RequiresGuard` allows a request with no principal and `@Public()` still
 * opts out of the global CombinedAuthGuard; `refresh` additionally keeps `JwtRefreshGuard`, because a
 * public catalog declaration is not refresh-token authentication. `/auth/me` and `/auth/logout`
 * declare implicit keys: any authenticated principal passes the guard, and the handler's own
 * `validateUser` refusal (401 `auth`) is what an agent gets.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register a new user' })
  @ApiResponse({ status: 201, type: AuthResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid input' })
  @ApiResponse({ status: 403, description: 'Registration is closed' })
  @Public()
  @UseGuards(RequiresGuard)
  @Requires('auth.register')
  @Throttle({ default: { limit: AUTH_LOGIN_LIMIT, ttl: AUTH_LOGIN_TTL_MS } })
  async register(@Body() registerDto: RegisterDto) {
    const data = await this.authService.register(registerDto);
    return JsonResponse.Ok(data);
  }

  @Get('registration-status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Whether self-registration is open' })
  @ApiResponse({ status: 200, type: RegistrationStatusDto })
  @Public()
  @UseGuards(RequiresGuard)
  @Requires('auth.registration.read')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async registrationStatus() {
    const data = await this.authService.registrationStatus();
    return JsonResponse.Ok(data);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with email and password' })
  @ApiResponse({ status: 200, type: AuthResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  @Public()
  @UseGuards(RequiresGuard)
  @Requires('session.login')
  @Throttle({ default: { limit: AUTH_LOGIN_LIMIT, ttl: AUTH_LOGIN_TTL_MS } })
  async login(@Body() loginDto: LoginDto) {
    const data = await this.authService.login(loginDto);
    return JsonResponse.Ok(data);
  }

  /**
   * @design @Public() opts out of the global CombinedAuthGuard (access-token path); JwtRefreshGuard
   * validates the refresh token independently.
   *
   * auth-passwords US-005: the handler is the one auth route that reads the raw request, because the
   * client's User-Agent and IP are what a lost-response recovery is matched against. The User-Agent is a
   * header, so an array value uses its first entry; the IP comes from `getClientIp` and the trusted-proxy
   * list, never Fastify's `req.ip`, which is the socket peer behind the Nuxt proxy (#470).
   */
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Refresh access and refresh tokens' })
  @ApiResponse({ status: 200, type: AuthResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid or missing token' })
  @Public()
  @UseGuards(JwtRefreshGuard, RequiresGuard)
  @Requires('session.refresh')
  async refresh(@Principal() user: IPrincipal, @Req() req: RefreshRequestLike) {
    const data = await this.authService.refresh(user, refreshClientFrom(req));
    return JsonResponse.Ok(data);
  }

  @Get('me')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current authenticated user' })
  @ApiResponse({ status: 200, type: UserResponseDto })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  @UseGuards(RequiresGuard)
  @Requires('auth.me.read')
  async me(@Principal() user: IPrincipal) {
    const validatedUser = await this.authService.validateUser(user);
    if (!validatedUser) {
      throw new AuthException({}, 'auth');
    }
    // Final-review Finding D: validateUser returns the full user row including
    // passwordHash — map through UserResponseDto (the same DTO login/register
    // use) so the hash is never serialized in the response.
    return JsonResponse.Ok(await this.authService.userResponse(validatedUser));
  }

  @Post('password')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Change the current user password' })
  @ApiResponse({ status: 200, description: 'Password changed' })
  @ApiResponse({ status: 403, description: 'Current password is incorrect' })
  @UseGuards(RequiresGuard)
  @Requires('session.password.change')
  @Throttle({ default: { limit: AUTH_LOGIN_LIMIT, ttl: AUTH_LOGIN_TTL_MS } })
  async changePassword(@Principal() user: KodaPrincipal, @Body() dto: ChangePasswordDto) {
    await this.authService.changePassword(user, dto);
    return JsonResponse.Ok({});
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke the current session (all sessions for a token issued before sessions)' })
  @ApiResponse({ status: 200, description: 'Tokens revoked' })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  @UseGuards(RequiresGuard)
  @Requires('session.logout')
  @Throttle({ default: { limit: AUTH_LOGIN_LIMIT, ttl: AUTH_LOGIN_TTL_MS } })
  async logout(@Principal() user: KodaPrincipal) {
    // auth-sessions US-003: a user token names its session, so only that device is signed out; a legacy
    // user token and every agent principal carry no session and keep the all-sessions behaviour.
    await this.authService.logout(user.id, isUserPrincipal(user) ? user.sessionId : undefined);
    return JsonResponse.Ok({});
  }
}
