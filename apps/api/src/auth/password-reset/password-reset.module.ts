import { Module } from '@nestjs/common';
import { AuthRepositoryModule } from '../auth-repository.module';
import { AuthSessionsModule } from '../sessions/auth-sessions.module';
import { NotificationsModule } from '../../notifications/notifications.module';
import { PasswordResetController } from './password-reset.controller';
import { PasswordResetService } from './password-reset.service';
import { PasswordResetStoreModule } from './password-reset-store.module';

/**
 * auth-passwords US-003: the public reset surface.
 *
 * `AuthModule` imports the leaf `PasswordResetStoreModule` instead of this module, so the dependency
 * `AuthModule` → `NotificationsModule` → `LiveModule` → `AuthModule` is never closed. This module may
 * import `NotificationsModule` because nothing imports it back.
 *
 * `EmailAvailability` and `EmailScheduleService` come from the global `EmailCoreModule`.
 */
@Module({
  imports: [PasswordResetStoreModule, AuthRepositoryModule, AuthSessionsModule, NotificationsModule],
  controllers: [PasswordResetController],
  providers: [PasswordResetService],
})
export class PasswordResetModule {}
