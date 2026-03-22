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
import type { JwtPayload } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { AuthResponseDto, UserResponseDto } from './dto/auth-response.dto';
import { Public, Principal, JwtRefreshGuard } from '@nathapp/nestjs-auth';
import type { IPrincipal } from './types';
import { Throttle } from '@nathapp/nestjs-throttler';
import { AuthException, JsonResponse } from '@nathapp/nestjs-common';

@ApiTags('auth')
@Throttle({ default: { limit: 10, ttl: 60000 } })
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register a new user' })
  @ApiResponse({ status: 201, type: AuthResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid input' })
  @Public()
  async register(@Body() registerDto: RegisterDto) {
    const data = await this.authService.register(registerDto);
    return JsonResponse.Ok(data);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with email and password' })
  @ApiResponse({ status: 200, type: AuthResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  @Public()
  async login(@Body() loginDto: LoginDto) {
    const data = await this.authService.login(loginDto);
    return JsonResponse.Ok(data);
  }

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
  async me(@Principal() user: JwtPayload) {
    const validatedUser = await this.authService.validateUser(user);
    if (!validatedUser) {
      throw new AuthException();
    }
    return JsonResponse.Ok(validatedUser);
  }
}
