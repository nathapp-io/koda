import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { AUTH_SESSION_REPOSITORY } from './auth-session.domain';
import { AuthSessionService } from './auth-session.service';
import { PrismaAuthSessionRepository } from './prisma-auth-session.repository';

/**
 * auth-sessions US-001 — the session store, a leaf module.
 *
 * It imports `PrismaModule` and nothing else, so it adds no edge to the module graph. The repository and
 * its token are module-private (the `memory.module.ts` shape, minus its legacy repository/token exports);
 * `AuthSessionService` is the whole public contract.
 *
 * `AuthModule` must import this module in two places (US-002): in its own `imports`, and in the `imports`
 * of `NathappAuthModule.forRootAsync(...)`, because the refresh strategy is instantiated inside that
 * submodule and sees only its own imports — the same reason `AuthRepositoryModule` exists.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    PrismaAuthSessionRepository,
    { provide: AUTH_SESSION_REPOSITORY, useExisting: PrismaAuthSessionRepository },
    AuthSessionService,
  ],
  exports: [AuthSessionService],
})
export class AuthSessionsModule {}
