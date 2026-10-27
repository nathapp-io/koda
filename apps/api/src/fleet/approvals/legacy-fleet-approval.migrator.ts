import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { randomUUID } from 'node:crypto';
import { runAsSystem } from '../../action-context/action-context';
import { approvalInputHash, freezeApprovalInput } from '../../approvals/approval-input';
import { DEFAULT_APPROVAL_TIMEOUT_SEC } from '../../approvals/domain/approval.domain';
import { FLEET_CFG, type IFleetConfig } from '../../config/fleet.config';
import { Prisma, type PrismaClient } from '../../generated/prisma/client';
import { FLEET_ASK_KEY } from './domain/approval.domain';

/** How many legacy rows one batch copies; the drain loops until the table has nothing left. */
export const MIGRATION_BATCH = 200;
/** The most batches one pass (a boot, or one tick) copies, so a runaway table cannot hold the entry point. */
export const MAX_BATCHES_PER_PASS = 100;

/** The legacy statuses the engine understands as they are; a legacy `approved` became `executed`. */
const STATUS_MAP: Readonly<Record<string, string>> = {
  pending: 'pending', rejected: 'rejected', cancelled: 'cancelled', expired: 'expired', approved: 'executed',
};

/** The decisions the fleet gave that mean "no". */
const REJECTING_DECISIONS: ReadonlySet<string> = new Set(['deny', 'keep_paused', 'reject']);
const LEGACY_NO_EXPIRY = new Date('9999-12-31T23:59:59.999Z');

interface LegacyRow {
  id: string; type: string; projectId: string | null; jobId: string | null; leaseEpoch: number | null; naxAskId: string | null;
  policyId: string | null; payload: Prisma.JsonValue; outcome: Prisma.JsonValue; requestedAt: Date; expiresAt: Date | null;
  status: string; decision: string | null; decidedById: string | null; decidedAt: Date | null; resolvedBy: string | null;
  comment: string | null; createdAt: Date;
}

/**
 * Permissions P3 US-007 (fix rounds 2-3): copies the `FleetApproval` rows the fleet accumulated before the asks moved onto
 * the engine into `ApprovalRequest` + `FleetApprovalAsk`, keeping the row's id so `BudgetIncident.approvalId` and any
 * other external reference still names the same ask.
 *
 * It is idempotent and self-healing:
 * - the copy of one legacy row is **one transaction** (request, link and decision commit together, so a partial failure
 *   leaves no half-migrated ask);
 * - a row counts as migrated only when its **link** exists, so a row whose request survived an interrupted earlier
 *   attempt is finished on the next pass (`skipDuplicates` absorbs the request);
 * - a pending row keeps its explicit deadline, or the legacy no-expiry sentinel; new asks still use policy timeouts;
 * - linked pending/expired requests with an erroneous finite deadline are repaired too, without undoing decisions;
 * - it runs on boot and on a timer independently of FLEET_SWEEP_ENABLED;
 * - each batch durably rotates attempts before copying, so poison rows cannot starve later rows even after a restart.
 *
 * `US-012` deletes this class with the table it reads.
 */
@Injectable()
export class LegacyFleetApprovalMigrator implements OnApplicationBootstrap, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LegacyFleetApprovalMigrator.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService<PrismaClient>,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    @Inject(FLEET_CFG) private readonly fleetConfig: Pick<IFleetConfig, 'approvalSweepMs'>,
  ) {}

  private get db() {
    return this.prisma.client;
  }

  /** Best effort: a failure is logged and the API still starts; the next pass (a tick, or the next boot) retries. */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.pass();
    } catch (error) {
      this.logger.warn(`legacy fleet approval migration failed: ${reason(error)}`);
    }
  }

  /** The durable continuation: a legacy row written after the boot pass is copied without a restart. */
  onModuleInit(): void {
    this.timer = setInterval(() => {
      this.pass().catch((error: unknown) => this.logger.warn(`legacy fleet approval migration failed: ${reason(error)}`));
    }, this.fleetConfig.approvalSweepMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One bounded pass (the boot hook and each tick): `seed` is the context every boot seeder writes under. */
  pass(): Promise<number> {
    return runAsSystem('seed', () => this.migrateAll());
  }

  /** Every batch up to `MAX_BATCHES_PER_PASS`; the next pass continues whatever is left. */
  async migrateAll(): Promise<number> {
    let total = 0;
    for (let batch = 0; batch < MAX_BATCHES_PER_PASS; batch += 1) {
      const result = await this.copyBatch(MIGRATION_BATCH);
      total += result.migrated;
      // Attempt count, not success count: failed rows must not hide the rest of the queue.
      if (result.attempted < MIGRATION_BATCH) break;
    }
    if (total > 0) this.logger.log(`migrated ${total} legacy fleet approval(s) onto the approval engine`);
    return total;
  }

  /** One bounded batch: missing links and requests copied with an erroneous legacy timeout. */
  async migrateBatch(limit = MIGRATION_BATCH): Promise<number> {
    return (await this.copyBatch(limit)).migrated;
  }

  private async copyBatch(limit: number): Promise<{ attempted: number; migrated: number }> {
    // Autocommit scheduling statement, outside each copy transaction: a failed copy cannot roll back its queue position.
    const rows = await this.db.$queryRaw<LegacyRow[]>`
      WITH next AS (
        SELECT f."id" FROM "FleetApproval" f
        WHERE NOT EXISTS (SELECT 1 FROM "FleetApprovalAsk" a WHERE a."requestId" = f."id")
          OR (f."status" = 'pending' AND f."expiresAt" IS NULL AND EXISTS (
            SELECT 1 FROM "ApprovalRequest" r
            WHERE r."id" = f."id" AND r."correlationId" = f."id" AND r."actorType" = 'SYSTEM'
              AND r."status" IN ('pending', 'expired') AND r."expiresAt" <> ${LEGACY_NO_EXPIRY}
              AND NOT EXISTS (SELECT 1 FROM "ApprovalDecision" d WHERE d."requestId" = r."id")
          ))
        ORDER BY f."updatedAt" ASC, f."id" ASC
        LIMIT ${limit}
        FOR UPDATE OF f SKIP LOCKED
      )
      UPDATE "FleetApproval" f SET "updatedAt" = clock_timestamp()
      FROM next WHERE f."id" = next."id"
      RETURNING f.*
    `;
    let migrated = 0;
    for (const row of rows) {
      try {
        await this.copy(row);
        migrated += 1;
      } catch (error) {
        this.logger.warn(`legacy approval ${row.id} was not migrated: ${reason(error)}`);
      }
    }
    return { attempted: rows.length, migrated };
  }

  /**
   * One legacy row as an engine request, its link and (when it was decided) its decision — in one transaction, so a
   * failure leaves nothing half-migrated. An already-present id is left alone (`skipDuplicates`).
   */
  private copy(row: LegacyRow): Promise<void> {
    return this.txManager.run(async () => {
      const kind = row.type === 'nax_bash_escalate' ? 'bash' : 'budget';
      const status = STATUS_MAP[row.status] ?? 'pending';
      const settled = status !== 'pending';
      const decidedAt = row.decidedAt ?? (settled ? row.createdAt : null);
      const onBehalfOf = kind === 'bash' ? await this.requesterOf(row.jobId) : null;
      const input = freezeApprovalInput(this.inputOf(row, kind));

      // A request that survived an interrupted earlier attempt is absorbed here and finished by the link below.
      await this.db.approvalRequest.createMany({
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
          // Compatibility only: a null legacy deadline must not become a new 24h timeout.
          expiresAt: pendingExpiry(status, row),
          decidedAt: row.decidedById === null ? null : decidedAt,
          settledAt: settled ? decidedAt : null,
          result: status === 'cancelled' ? { closedBy: row.resolvedBy ?? 'user' } : Prisma.DbNull,
          createdAt: row.createdAt,
        }],
        skipDuplicates: true,
      });

      await this.db.fleetApprovalAsk.createMany({
        data: [{
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
        }],
        skipDuplicates: true,
      });

      // Earlier versions imposed a finite deadline even on non-expiring legacy asks. The link's existence must not
      // hide those rows, including ones already expired by the engine. CAS under the request lock preserves a decision
      // or lifecycle close that won the race; only a migration-owned, undecided pending/expired request can be restored.
      if (row.status === 'pending' && row.expiresAt === null) {
        const repaired = await this.db.approvalRequest.updateMany({
          where: {
            id: row.id, correlationId: row.id, actorType: 'SYSTEM', status: { in: ['pending', 'expired'] },
            expiresAt: { not: LEGACY_NO_EXPIRY }, decisions: { none: {} },
          },
          data: { expiresAt: LEGACY_NO_EXPIRY, status: 'pending', settledAt: null, result: Prisma.DbNull },
        });
        if (repaired.count > 0) {
          await this.db.fleetApprovalAsk.updateMany({ where: { requestId: row.id, resolvedBy: 'timeout' }, data: { resolvedBy: null } });
          await this.db.fleetApprovalAsk.updateMany({ where: { requestId: row.id, recordedStatus: 'expired' }, data: { recordedStatus: null } });
          await this.db.fleetApprovalAsk.updateMany({ where: { requestId: row.id, publishedStatus: 'expired' }, data: { publishedStatus: null } });
        }
      }

      if (row.decision !== null && row.decidedById !== null) {
        await this.db.approvalDecision.createMany({
          data: [{
            // Deterministic, so a re-run of the same row cannot record its decision twice.
            id: `legacy-${row.id}`,
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
          }],
          skipDuplicates: true,
        });
      }
    });
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

/** The engine requires a date. Reserve the end of the four-digit calendar for legacy no-expiry rows only. */
function pendingExpiry(status: string, row: LegacyRow): Date {
  if (row.expiresAt !== null) return row.expiresAt;
  return status === 'pending'
    ? LEGACY_NO_EXPIRY
    : new Date(row.createdAt.getTime() + DEFAULT_APPROVAL_TIMEOUT_SEC * 1000);
}

const text = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.length > 0 ? value : typeof value === 'number' ? String(value) : fallback;

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
