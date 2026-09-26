import {
  Controller,
  Post,
  Get,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { AuthResponseDto, UserResponseDto } from './dto/auth-response.dto';
import { RegistrationStatusDto } from './dto/registration-status.dto';
import { Public, Principal, JwtRefreshGuard } from '@nathapp/nestjs-auth';
import type { IPrincipal } from './types';
import { Throttle } from '@nathapp/nestjs-throttler';
import { AuthException, JsonResponse } from '@nathapp/nestjs-common';

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
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async register(@Body() registerDto: RegisterDto) {
    const data = await this.authService.register(registerDto);
    return JsonResponse.Ok(data);
  }

  @Get('registration-status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Whether self-registration is open' })
  @ApiResponse({ status: 200, type: RegistrationStatusDto })
  @Public()
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
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async login(@Body() loginDto: LoginDto) {
    const data = await this.authService.login(loginDto);
    return JsonResponse.Ok(data);
  }

  /** @design @Public() opts out of the global CombinedAuthGuard (access-token path); JwtRefreshGuard validates the refresh token independently. */
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Refresh access and refresh tokens' })
  @ApiResponse({ status: 200, type: AuthResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid or missing token' })
  @Public()
  @UseGuards(JwtRefreshGuard)
  async refresh(@Principal() user: IPrincipal) {
    const data = await this.authService.refresh(user);
    return JsonResponse.Ok(data);
  }

  @Get('me')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current authenticated user' })
  @ApiResponse({ status: 200, type: UserResponseDto })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  async me(@Principal() user: IPrincipal) {
    const validatedUser = await this.authService.validateUser(user);
    if (!validatedUser) {
      throw new AuthException({}, 'auth');
    }
    // Final-review Finding D: validateUser returns the full user row including
    // passwordHash — map through UserResponseDto (the same DTO login/register
    // use) so the hash is never serialized in the response.
    return JsonResponse.Ok(UserResponseDto.from(validatedUser));
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke all outstanding access and refresh tokens for the current user' })
  @ApiResponse({ status: 200, description: 'Tokens revoked' })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async logout(@Principal() user: IPrincipal) {
    await this.authService.logout(user.id);
    return JsonResponse.Ok({});
  }
}
