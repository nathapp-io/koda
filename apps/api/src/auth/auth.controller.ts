import {
  Controller,
  Post,
  Get,
  Body,
  UseGuards,
  Headers,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthService, JwtPayload } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { AuthResponseDto, UserResponseDto } from './dto/auth-response.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from '@nathapp/nestjs-auth';
import { AppException } from '../common/app-exception';
import { JsonResponse } from '../common/json-response';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register a new user' })
  @ApiResponse({ status: 201, type: AuthResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid input' })
  @Public()
  async register(@Body() registerDto: RegisterDto): Promise<JsonResponse<AuthResponseDto>> {
    const data = await this.authService.register(registerDto);
    return JsonResponse.created(data as unknown as AuthResponseDto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with email and password' })
  @ApiResponse({ status: 200, type: AuthResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  @Public()
  async login(@Body() loginDto: LoginDto): Promise<JsonResponse<AuthResponseDto>> {
    const data = await this.authService.login(loginDto);
    return JsonResponse.ok(data as unknown as AuthResponseDto);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Refresh access and refresh tokens' })
  @ApiResponse({ status: 200, type: AuthResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid or missing token' })
  @Public()
  async refresh(
    @Headers('authorization') authHeader: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<JsonResponse<AuthResponseDto>> {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AppException('errors.unauthorized', HttpStatus.UNAUTHORIZED);
    }
    const data = await this.authService.refresh(user);
    return JsonResponse.ok(data as unknown as AuthResponseDto);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current authenticated user' })
  @ApiResponse({ status: 200, type: UserResponseDto })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  async me(@CurrentUser() user: JwtPayload): Promise<JsonResponse<UserResponseDto>> {
    const validatedUser = await this.authService.validateUser(user);
    if (!validatedUser) {
      throw new AppException('errors.unauthorized', HttpStatus.UNAUTHORIZED);
    }
    return JsonResponse.ok(validatedUser as unknown as UserResponseDto);
  }
}
