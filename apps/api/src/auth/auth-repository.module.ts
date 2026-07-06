import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { PrismaAuthRepository } from './prisma-auth.repository';
import { AUTH_REPOSITORY } from './domain/auth.domain';

/**
 * Split out from AuthModule so PrismaAuthRepository can also be imported by the
 * @nathapp/nestjs-auth dynamic submodules (AuthenticationModule) that back the
 * authProvider/refreshStrategyProvider useClass options — those submodules only
 * see providers from modules explicitly listed in their own `imports`.
 */
@Module({
  imports: [PrismaModule],
  providers: [PrismaAuthRepository, { provide: AUTH_REPOSITORY, useExisting: PrismaAuthRepository }],
  exports: [PrismaAuthRepository, AUTH_REPOSITORY],
})
export class AuthRepositoryModule {}
