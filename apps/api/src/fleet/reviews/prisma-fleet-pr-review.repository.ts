import { Inject, Injectable } from '@nestjs/common';
import { AbstractPrismaRepository, PrismaService, type PrismaModelDelegate } from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import { FleetPrReview as ReviewRow, Prisma, type PrismaClient } from '../../generated/prisma/client';
import type { PrincipalRef } from '../../permissions/permissions.types';
import {
  FleetPrReviewRecord, IFleetPrReviewRepository, PrincipalAccess,
} from './domain/fleet-pr-review.domain';

/** Fleet auto-review (spec §`FleetPrReview`): the claim and outcome of one PR head. */
@Injectable()
export class PrismaFleetPrReviewRepository
  extends AbstractPrismaRepository<FleetPrReviewRecord, ReviewRow, string>
  implements IFleetPrReviewRepository {
  constructor(@Inject(TRANSACTION_MANAGER) tx: ITransactionManager, private readonly prisma: PrismaService<PrismaClient>) {
    super(tx);
  }

  /** Transaction-scoped inside txManager.run (nestjs-prisma ALS proxy). */
  private get db() {
    return this.prisma.client;
  }

  protected modelDelegate(client: unknown): PrismaModelDelegate<ReviewRow, string> {
    return (client as Record<string, unknown>).fleetPrReview as PrismaModelDelegate<ReviewRow, string>;
  }

  protected toDomain(model: ReviewRow): FleetPrReviewRecord {
    return { ...model };
  }

  protected toPersistenceCreate(record: FleetPrReviewRecord) {
    return this.toPersistenceUpdate(record);
  }

  protected toPersistenceUpdate(patch: Partial<FleetPrReviewRecord>) {
    return { ...patch };
  }

  async findHead(repoId: string, prNumber: number, headSha: string): Promise<FleetPrReviewRecord | null> {
    const row = await this.db.fleetPrReview.findUnique({ where: { repoId_prNumber_headSha: { repoId, prNumber, headSha } } });
    return row === null ? null : this.toDomain(row);
  }

  /**
   * The claim. A second pass for the same head loses on the unique index and gets null, so it dispatches
   * nothing; only that violation is swallowed, a real database failure still propagates.
   */
  async insertPending(repoId: string, prNumber: number, headSha: string): Promise<FleetPrReviewRecord | null> {
    try {
      const row = await this.db.fleetPrReview.create({ data: { repoId, prNumber, headSha, outcome: 'pending' } });
      return this.toDomain(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return null;
      throw error;
    }
  }

  async markDispatched(id: string, jobId: string): Promise<void> {
    await this.db.fleetPrReview.update({ where: { id }, data: { outcome: 'dispatched', jobId } });
  }

  async markFailed(id: string, outcome: string): Promise<void> {
    await this.db.fleetPrReview.update({ where: { id }, data: { outcome } });
  }

  /** deleteMany: the row another pass already removed is not an error, and the head is free either way. */
  async remove(id: string): Promise<void> {
    await this.db.fleetPrReview.deleteMany({ where: { id } });
  }

  /**
   * Existence only, read from the principal's own table, as `PrismaScheduleRepository.findOwnerAccess` does.
   * A disabled USER is refused; an AGENT is never disabled (status is liveness, not access). Nothing is cached.
   */
  async findPrincipalAccess(ref: PrincipalRef): Promise<PrincipalAccess> {
    if (ref.type === 'AGENT') {
      const agent = await this.db.agent.findUnique({ where: { id: ref.id }, select: { id: true } });
      return { exists: agent !== null, disabled: false };
    }
    const user = await this.db.user.findUnique({ where: { id: ref.id }, select: { disabled: true } });
    return user === null ? { exists: false, disabled: false } : { exists: true, disabled: user.disabled };
  }
}
