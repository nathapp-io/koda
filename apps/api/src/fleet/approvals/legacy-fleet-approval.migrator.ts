import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { randomUUID } from 'node:crypto';
import { runAsSystem } from '../../action-context/action-context';
import { approvalInputHash, freezeApprovalInput } from '../../approvals/approval-input';
import { Prisma, type PrismaClient } from '../../generated/prisma/client';
import { FLEET_ASK_KEY } from './domain/approval.domain';

/** How many legacy rows one batch copies; the boot hook loops until the table has nothing left. */
export const MIGRATION_BATCH = 200;

/** The legacy statuses the engine understands as they are; a legacy `approved` became `executed`. */
const STATUS_MAP: Readonly<Record<string, string>> = {
  pending: 'pending', rejected: 'rejected', cancelled: 'cancelled', expired: 'expired', approved: 'executed',
};

/** The decisions the fleet gave that mean "no". */
const REJECTING_DECISIONS: ReadonlySet<string> = new Set(['deny', 'keep_paused', 'reject']);

interface LegacyRow {
  id: string; type: string; projectId: string | null; jobId: string | null; leaseEpoch: number | null; naxAskId: string | null;
  policyId: string | null; payload: Prisma.JsonValue; outcome: Prisma.JsonValue; requestedAt: Date; expiresAt: Date | null;
  status: string; decision: string | null; decidedById: string | null; decidedAt: Date | null; resolvedBy: string | null;
  comment: string | null; createdAt: Date;
}

/**
 * Permissions P3 US-007 (fix round 2): copies the `FleetApproval` rows the fleet accumulated before the asks moved onto
 * the engine into `ApprovalRequest` + `FleetApprovalAsk`, keeping the row's id so `BudgetIncident.approvalId` and any
 * other external reference still names the same ask.
 *
 * It runs on every boot and is idempotent (a row whose id already has a request is skipped), so a deployment that
 * restarts heals itself, and the frozen `input`/`inputHash` are built with the app's own helpers — a migrated pending
 * ask is therefore decidable *and executable*, which a SQL copy could not guarantee. `US-012` deletes this class with
 * the table it reads.
 */
@Injectable()
export class LegacyFleetApprovalMigrator implements OnApplicationBootstrap {
  private readonly logger = new Logger(LegacyFleetApprovalMigrator.name);

  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  /** Best effort: a failure is logged and the API still starts; the next boot retries. */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const migrated = await runAsSystem('seed', () => this.migrateAll());
      if (migrated > 0) this.logger.log(`migrated ${migrated} legacy fleet approval(s) onto the approval engine`);
    } catch (error) {
      this.logger.warn(`legacy fleet approval migration failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Every batch, bounded by a page cap so a runaway table cannot hold the boot. */
  async migrateAll(): Promise<number> {
    let total = 0;
    for (let page = 0; page < 100; page += 1) {
      const migrated = await this.migrateBatch();
      total += migrated;
      if (migrated < MIGRATION_BATCH) return total;
    }
    this.logger.warn(`legacy fleet approval migration stopped after ${100 * MIGRATION_BATCH} rows; the next boot continues`);
    return total;
  }

  /** One bounded batch: the legacy rows whose id the engine does not know yet. */
  async migrateBatch(limit = MIGRATION_BATCH): Promise<number> {
    const rows = await this.db.$queryRaw<LegacyRow[]>`
      SELECT f.* FROM "FleetApproval" f
      WHERE NOT EXISTS (SELECT 1 FROM "ApprovalRequest" r WHERE r."id" = f."id")
      ORDER BY f."createdAt" ASC
      LIMIT ${limit}
    `;
    let migrated = 0;
    for (const row of rows) {
      try {
        await this.copy(row);
        migrated += 1;
      } catch (error) {
        this.logger.warn(`legacy approval ${row.id} was not migrated: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return migrated;
  }

  /**
   * One legacy row as an engine request, its link and (when it was decided) its decision. Every write is a single row
   * and an already-present id is left alone, so a partial batch is simply resumed.
   */
  private async copy(row: LegacyRow): Promise<void> {
    const kind = row.type === 'nax_bash_escalate' ? 'bash' : 'budget';
    const status = STATUS_MAP[row.status] ?? 'pending';
    const settled = status !== 'pending';
    const decidedAt = row.decidedAt ?? (settled ? row.createdAt : null);
    const onBehalfOf = kind === 'bash' ? await this.requesterOf(row.jobId) : null;
    const input = freezeApprovalInput(this.inputOf(row, kind));

    const created = await this.db.approvalRequest.createMany({
      data: [{
        id: row.id,
        permissionKey: FLEET_ASK_KEY[row.type === 'nax_bash_escalate' ? 'nax_bash_escalate' : 'budget_override_required'],
        projectId: row.projectId,
        actorType: 'SYSTEM',
        actorId: kind === 'bash' ? 'runner' : 'budget',
        onBehalfOfType: onBehalfOf?.type ?? null,
        onBehalfOfId: onBehalfOf?.id ?? null,
        origin: kind === 'bash' ? 'runner' : 'system',
        // The legacy row kept no correlation id of its own; its id is the stable name of the ask.
        correlationId: row.id,
        input: input as Prisma.InputJsonValue,
        inputHash: approvalInputHash(input),
        requiredMode: 'agent',
        policyId: null,
        onTimeout: 'reject',
        approverMustHoldAction: true,
        requireDistinctApprover: false,
        status,
        satisfiedBy: row.decidedById === null ? null : 'human',
        approverType: row.decidedById === null ? null : 'USER',
        approverId: row.decidedById,
        // The engine's column is required; the legacy ask never expired, so 24 h from its creation is the same default.
        expiresAt: row.expiresAt ?? new Date(row.createdAt.getTime() + 86_400_000),
        decidedAt: row.decidedById === null ? null : decidedAt,
        settledAt: settled ? decidedAt : null,
        result: status === 'cancelled' ? { closedBy: row.resolvedBy ?? 'user' } : Prisma.DbNull,
        createdAt: row.createdAt,
      }],
      skipDuplicates: true,
    });
    if (created.count === 0) return;

    await this.db.fleetApprovalAsk.create({
      data: {
        requestId: row.id,
        kind,
        projectId: row.projectId,
        jobId: row.jobId,
        leaseEpoch: row.leaseEpoch,
        naxAskId: row.naxAskId,
        budgetPolicyId: row.policyId,
        // A cancelling close kept its reason; the view derives `user`/`timeout` for a decided or expired one.
        resolvedBy: status === 'cancelled' ? row.resolvedBy ?? 'user' : null,
        outcome: row.outcome === null ? Prisma.DbNull : row.outcome as Prisma.InputJsonValue,
      },
    });

    if (row.decision !== null && row.decidedById !== null) {
      await this.db.approvalDecision.create({
        data: {
          requestId: row.id,
          deciderType: 'USER',
          deciderId: row.decidedById,
          decision: REJECTING_DECISIONS.has(row.decision) ? 'reject' : 'approve',
          comment: row.comment,
          // The fleet view reads a bash approval's `choice` out of the decision's params.
          params: kind === 'bash' && !REJECTING_DECISIONS.has(row.decision)
            ? { choice: row.decision === 'allow_for_job' ? 'allow_for_job' : 'allow' }
            : Prisma.DbNull,
          decidedAt: decidedAt ?? row.createdAt,
        },
      });
    }
  }

  /** The frozen input each command parses: nax's payload for a bash ask, the stop snapshot for a budget ask. */
  private inputOf(row: LegacyRow, kind: 'bash' | 'budget'): Record<string, unknown> {
    const payload = (row.payload !== null && typeof row.payload === 'object' && !Array.isArray(row.payload))
      ? row.payload as Record<string, unknown>
      : {};
    if (kind === 'bash') {
      return { jobId: row.jobId, leaseEpoch: row.leaseEpoch, naxAskId: row.naxAskId, payload };
    }
    return {
      policyId: row.policyId,
      scopeType: text(payload['scopeType'], 'project'),
      scopeId: typeof payload['scopeId'] === 'string' ? payload['scopeId'] : null,
      windowKind: text(payload['windowKind'], 'calendar_month_utc'),
      windowStart: text(payload['windowStart'], row.requestedAt.toISOString()),
      spentUsd: text(payload['spentUsd'], '0'),
      amountUsd: text(payload['amountUsd'], '0'),
      requestedAt: row.requestedAt.toISOString(),
    };
  }

  /** The principal a relayed bash ask was raised for, when its job still knows it. */
  private async requesterOf(jobId: string | null): Promise<{ type: 'USER' | 'AGENT'; id: string } | null> {
    if (jobId === null) return null;
    const job = await this.db.fleetJob.findUnique({ where: { id: jobId }, select: { requestedById: true, requestedByType: true } });
    if (job === null) return null;
    const id = job.requestedById ?? randomUUID();
    return { type: job.requestedByType === 'AGENT' ? 'AGENT' : 'USER', id };
  }
}

const text = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.length > 0 ? value : typeof value === 'number' ? String(value) : fallback;
