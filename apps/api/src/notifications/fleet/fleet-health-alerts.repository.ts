import { Injectable } from '@nestjs/common';
import { PrismaClient } from '../../generated/prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { randomUUID } from 'crypto';
import { HEALTH_ALERT_KINDS, HealthAlertKind } from './fleet-notification-events';

export interface HealthRunnerRow { id: string; name: string; enabled: boolean; lastSeenAt: Date; capabilities: unknown }
export interface OpenHealthAlert { id: string; kind: HealthAlertKind; subjectKey: string }

const isKind = (k: string): k is HealthAlertKind => (HEALTH_ALERT_KINDS as readonly string[]).includes(k);

/** Fleet S4a §2.4 (D507): health alert episodes. Transaction-scoped inside txManager.run (nestjs-prisma ALS proxy). */
@Injectable()
export class FleetHealthAlertsRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  findRunners(): Promise<HealthRunnerRow[]> {
    return this.db.runner.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, name: true, enabled: true, lastSeenAt: true, capabilities: true },
    });
  }

  async findOpen(): Promise<OpenHealthAlert[]> {
    const rows = await this.db.fleetHealthAlert.findMany({
      where: { closedAt: null }, orderBy: { openedAt: 'asc' }, select: { id: true, kind: true, subjectKey: true },
    });
    return rows.flatMap((r) => (isKind(r.kind) ? [{ id: r.id, kind: r.kind, subjectKey: r.subjectKey }] : []));
  }

  /** Null when an open alert for (kind, subjectKey) exists (FleetHealthAlert_open_subject_key). */
  async open(kind: HealthAlertKind, subjectKey: string, now: Date): Promise<string | null> {
    const rows = await this.db.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "FleetHealthAlert" ("id", "kind", "subjectKey", "openedAt")
      VALUES (${randomUUID()}, ${kind}, ${subjectKey}, CAST(${now.toISOString()} AS timestamp(3)))
      ON CONFLICT DO NOTHING
      RETURNING "id"`;
    return rows[0]?.id ?? null;
  }

  async close(ids: readonly string[], now: Date): Promise<number> {
    if (ids.length === 0) return 0;
    const { count } = await this.db.fleetHealthAlert.updateMany({ where: { id: { in: [...ids] }, closedAt: null }, data: { closedAt: now } });
    return count;
  }

  async purgeClosed(before: Date): Promise<number> {
    const { count } = await this.db.fleetHealthAlert.deleteMany({ where: { closedAt: { lt: before } } });
    return count;
  }
}
