import { Injectable } from '@nestjs/common';
import { PrismaPasswordResetRepository } from './prisma-password-reset.repository';

@Injectable()
export class PasswordResetTokenStore {
  constructor(private readonly repo: PrismaPasswordResetRepository) {}
  replaceUnused(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    return this.repo.replaceUnused(userId, tokenHash, expiresAt);
  }
  findByHash(tokenHash: string) { return this.repo.findByHash(tokenHash); }
  markUsed(id: string, now: Date): Promise<number> { return this.repo.markUsed(id, now); }
  discardUnusedFor(userId: string): Promise<number> { return this.repo.deleteUnusedOf(userId); }
}
