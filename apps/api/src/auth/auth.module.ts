import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthModule as NathappAuthModule } from '@nathapp/nestjs-auth';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';

@Module({
  imports: [
    NathappAuthModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        jwtOptions: {
          secret: config.get<string>('JWT_SECRET'),
          signOption: {
            expiresIn: config.get<string>('JWT_EXPIRES_IN') ?? '7d',
          },
        },
        refreshJwtOptions: {
          secret: config.get<string>('JWT_REFRESH_SECRET'),
          signOption: {
            expiresIn: config.get<string>('JWT_REFRESH_EXPIRES_IN') ?? '30d',
          },
        },
      }),
    }),
  ],
  providers: [AuthService],
  controllers: [AuthController],
  exports: [AuthService],
})
export class AuthModule {}
