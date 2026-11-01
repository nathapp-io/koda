import { Inject, Injectable } from '@nestjs/common';
import { AbstractPrismaRepository, PrismaService, type PrismaModelDelegate } from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import type { FleetReviewEvent, PrismaClient } from '../../generated/prisma/client';
import type { FleetReviewEventRecord, IFleetReviewEventRepository, NewFleetReviewEvent } from './domain/fleet-review-event.domain';

@Injectable()
export class FleetReviewEventRepository
  extends AbstractPrismaRepository<FleetReviewEventRecord, FleetReviewEvent, string>
  implements IFleetReviewEventRepository {
  constructor(@Inject(TRANSACTION_MANAGER) tx: ITransactionManager, private readonly prisma: PrismaService<PrismaClient>) {
    super(tx);
  }

  protected modelDelegate(client: unknown): PrismaModelDelegate<FleetReviewEvent, string> {
    return (client as Record<string, unknown>).fleetReviewEvent as PrismaModelDelegate<FleetReviewEvent, string>;
  }
  protected toDomain(row: FleetReviewEvent): FleetReviewEventRecord { return { ...row }; }
  protected toPersistenceCreate(row: FleetReviewEventRecord) { return { ...row }; }
  protected toPersistenceUpdate(row: Partial<FleetReviewEventRecord>) { return { ...row }; }

  async insertMany(rows: NewFleetReviewEvent[]): Promise<number> {
    if (rows.length === 0) return 0;
    const result = await this.prisma.client.fleetReviewEvent.createMany({ data: rows, skipDuplicates: true });
    return result.count;
  }

  /** A pure, bounded read; no locking or status mutation. */
  async claimPending(limit: number): Promise<FleetReviewEventRecord[]> {
    const rows = await this.prisma.client.fleetReviewEvent.findMany({
      where: { status: 'pending' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: limit,
    });
    return rows.map(row => this.toDomain(row));
  }

  async markMinted(id: string, result: { memoryItemId: string; approverLogin: string }): Promise<void> {
    await this.prisma.client.fleetReviewEvent.update({ where: { id }, data: { status: 'minted', skipReason: null, ...result } });
  }
  async markSkipped(id: string, reason: string): Promise<void> {
    await this.prisma.client.fleetReviewEvent.update({ where: { id }, data: { status: 'skipped', skipReason: reason } });
  }
  async bumpAttempt(id: string): Promise<number> {
    const row = await this.prisma.client.fleetReviewEvent.update({ where: { id }, data: { attempts: { increment: 1 } }, select: { attempts: true } });
    return row.attempts;
  }
}
