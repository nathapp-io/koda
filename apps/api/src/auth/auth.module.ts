import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthModule as NathappAuthModule, JwtStrategy, JwtRefreshStrategy } from '@nathapp/nestjs-auth';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtAuthProvider } from './jwt-auth.provider';
import { KodaJwtRefreshStrategyProvider } from './koda-jwt-refresh-strategy.provider';
import { CombinedAuthGuard } from './guards/combined-auth.guard';
import { AgentAuthProvider } from './agent-auth.provider';
import { KodaCaslAbilityFactory } from './casl/koda-casl-ability.factory';
import { AuthRepositoryModule } from './auth-repository.module';

@Module({
  imports: [
    AuthRepositoryModule,
    NathappAuthModule.forRootAsync({
      imports: [ConfigModule, AuthRepositoryModule],
      inject: [ConfigService],
      authProvider: { useClass: JwtAuthProvider },
      refreshStrategyProvider: { useClass: KodaJwtRefreshStrategyProvider },
      caslAbilityFactory: KodaCaslAbilityFactory,
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
              expiresIn: authConfig?.jwtExpiresIn ?? '15m',
            },
          },
          refreshJwtOptions: {
            secret: authConfig?.jwtRefreshSecret,
            signOption: {
              expiresIn: authConfig?.jwtRefreshExpiresIn ?? '7d',
            },
          },
        };
      },
    }),
  ],
  providers: [
    AuthService,
    JwtAuthProvider,
    KodaJwtRefreshStrategyProvider,
    JwtStrategy,
    JwtRefreshStrategy,
    AgentAuthProvider,
    CombinedAuthGuard,
    KodaCaslAbilityFactory,
  ],
  controllers: [AuthController],
  exports: [AuthService, CombinedAuthGuard, AgentAuthProvider, KodaCaslAbilityFactory],
})
export class AuthModule {}
