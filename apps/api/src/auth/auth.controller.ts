import {
  Controller,
  Post,
  Get,
  Body,
  Headers,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthService, JwtPayload } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { AuthResponseDto, UserResponseDto } from './dto/auth-response.dto';
import { Public, Principal } from '@nathapp/nestjs-auth';
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
  async register(@Body() registerDto: RegisterDto): Promise<JsonResponse<unknown>> {
    const data = await this.authService.register(registerDto);
    return JsonResponse.Ok(data);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with email and password' })
  @ApiResponse({ status: 200, type: AuthResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  @Public()
  async login(@Body() loginDto: LoginDto): Promise<JsonResponse<unknown>> {
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
  async refresh(
    @Principal() user: JwtPayload,
    @Headers('authorization') authHeader: string,
  ): Promise<JsonResponse<unknown>> {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AuthException();
    }
    const data = await this.authService.refresh(user);
    return JsonResponse.Ok(data);
  }

  @Get('me')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current authenticated user' })
  @ApiResponse({ status: 200, type: UserResponseDto })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  async me(@Principal() user: JwtPayload): Promise<JsonResponse<unknown>> {
    const validatedUser = await this.authService.validateUser(user);
    if (!validatedUser) {
      throw new AuthException();
    }
    return JsonResponse.Ok(validatedUser);
  }
}
