import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthModule as NathappAuthModule } from '@nathapp/nestjs-auth';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtAuthProvider } from './jwt-auth.provider';

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
  providers: [AuthService, JwtAuthProvider],
  controllers: [AuthController],
  exports: [AuthService],
})
export class AuthModule {}
