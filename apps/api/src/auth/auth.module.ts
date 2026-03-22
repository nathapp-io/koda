import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthModule as NathappAuthModule, JwtStrategy, JwtRefreshStrategy } from '@nathapp/nestjs-auth';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtAuthProvider } from './jwt-auth.provider';
import { CombinedAuthGuard } from './guards/combined-auth.guard';

@Module({
  imports: [
    NathappAuthModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      authProvider: { useClass: JwtAuthProvider },   // outside factory — JwtModuleAsyncOptions level
      useFactory: (config: ConfigService) => {
        const authConfig = config.get<{
          jwtSecret: string;
          jwtExpiresIn: string;
          jwtRefreshSecret: string;
          jwtRefreshExpiresIn: string;
        }>('auth');
        return {
          jwtOptions: {
            secret: authConfig?.jwtSecret,
            signOption: {
              expiresIn: authConfig?.jwtExpiresIn ?? '7d',
            },
          },
          refreshJwtOptions: {
            secret: authConfig?.jwtRefreshSecret,
            signOption: {
              expiresIn: authConfig?.jwtRefreshExpiresIn ?? '30d',
            },
          },
        };
      },
    }),
  ],
  // JwtStrategy + JwtRefreshStrategy must be in providers to register with Passport
  // (@nathapp/nestjs-auth ARCH-2: not auto-registered by AuthModule)
  providers: [AuthService, JwtAuthProvider, JwtStrategy, JwtRefreshStrategy, CombinedAuthGuard],
  controllers: [AuthController],
  exports: [AuthService, CombinedAuthGuard],
})
export class AuthModule {}
