import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { PrismaPasswordResetRepository } from './prisma-password-reset.repository';
import { PasswordResetTokenStore } from './password-reset-token.store';

@Module({
  imports: [PrismaModule],
  providers: [PrismaPasswordResetRepository, PasswordResetTokenStore],
  exports: [PasswordResetTokenStore],
})
export class PasswordResetStoreModule {}
