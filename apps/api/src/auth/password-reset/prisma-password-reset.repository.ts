import { Inject, Injectable } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { AbstractPrismaRepository, PrismaClientLike, PrismaModelDelegate, PrismaService } from '@nathapp/nestjs-prisma';
import { PasswordResetToken, PrismaClient } from '../../generated/prisma/client';

type Token = { id: string; userId: string; tokenHash: string; expiresAt: Date; usedAt: Date | null; createdAt: Date };

@Injectable()
export class PrismaPasswordResetRepository extends AbstractPrismaRepository<Token, PasswordResetToken, string> {
  constructor(@Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager, private readonly prisma: PrismaService<PrismaClient>) { super(txManager); }
  protected modelDelegate(client: PrismaClientLike): PrismaModelDelegate<PasswordResetToken, string> {
    return (client as unknown as Record<string, PrismaModelDelegate<PasswordResetToken, string>>)['passwordResetToken'];
  }
  protected toDomain(model: PasswordResetToken): Token { return { ...model }; }
  protected toPersistenceCreate(token: Token) { return { ...token }; }
  protected toPersistenceUpdate(token: Partial<Token>) { return { ...token }; }

  async replaceUnused(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    await this.txManager.run(async () => {
      // A user row exists even when there are no tokens; lock it to serialize concurrent replacements.
      await this.prisma.client.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
      await this.prisma.client.passwordResetToken.deleteMany({ where: { userId, usedAt: null } });
      await this.prisma.client.passwordResetToken.create({ data: { userId, tokenHash, expiresAt } });
    });
  }
  async findByHash(tokenHash: string) {
    const row = await this.prisma.client.passwordResetToken.findUnique({ where: { tokenHash }, include: { user: { select: { disabled: true } } } });
    return row ? { id: row.id, userId: row.userId, expiresAt: row.expiresAt, usedAt: row.usedAt, userDisabled: row.user.disabled } : null;
  }
  async markUsed(id: string, now: Date): Promise<number> {
    return (await this.prisma.client.passwordResetToken.updateMany({ where: { id, usedAt: null }, data: { usedAt: now } })).count;
  }
  async deleteUnusedOf(userId: string): Promise<number> {
    return (await this.prisma.client.passwordResetToken.deleteMany({ where: { userId, usedAt: null } })).count;
  }
}
