import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '../../src/generated/prisma/client';
import { approvalInputHash, freezeApprovalInput } from '../../src/approvals/approval-input';
import type { ApprovalRequestStatus } from '../../src/approvals/domain/approval.domain';
import type { ApprovalResolvedBy } from '../../src/fleet/approvals/domain/approval.domain';
import type { ApprovalMode } from '../../src/permissions/catalog';

/**
 * Permissions P3 (US-002): the fleet's asks are `ApprovalRequest` rows with a `FleetApprovalAsk` link,
 * and every AC of the read model needs one. This writes exactly those three row kinds and nothing
 * else: the jobs, budget policies and re-queue candidate jobs a test needs stay that test's own setup.
 */
export interface SeedFleetAskSpec {
  kind: 'bash' | 'budget';
  projectId: string | null;
  /** `BashAskInput` or `BudgetAskInput`, frozen as given. */
  input: Record<string, unknown>;
  status?: ApprovalRequestStatus;
  requiredMode?: ApprovalMode;
  onBehalfOf?: { type: 'USER' | 'AGENT'; id: string } | null;
  createdAt?: Date;
  expiresAt?: Date;
  settledAt?: Date | null;
  result?: unknown;
  decisions?: Array<{
    deciderType: 'USER' | 'AGENT'; deciderId: string; decision: 'approve' | 'reject';
    params?: unknown; comment?: string | null; decidedAt?: Date;
  }>;
  link?: {
    jobId?: string; leaseEpoch?: number; naxAskId?: string; budgetPolicyId?: string;
    resolvedBy?: ApprovalResolvedBy | null; outcome?: Record<string, unknown> | null;
  };
}

/** The engine key each ask kind is opened with, and the system component that raises it. */
const ASK = {
  bash: { key: 'fleet.job.shell.escalate', component: 'runner', origin: 'runner' },
  budget: { key: 'fleet.budget.override', component: 'budget', origin: 'system' },
} as const;

const HOUR_MS = 3_600_000;

/** A `Json` column takes an input value; `Json?` takes `Prisma.DbNull` for "no value". */
const jsonValue = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;
const nullableJson = (value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull =>
  value === null || value === undefined ? Prisma.DbNull : jsonValue(value);

export async function seedFleetAsk(db: PrismaClient, spec: SeedFleetAskSpec): Promise<{ requestId: string }> {
  const createdAt = spec.createdAt ?? new Date();
  const ask = ASK[spec.kind];
  // Frozen once, so the stored input is the value the hash describes (US-011 re-hashes it).
  const input = freezeApprovalInput(spec.input);

  const request = await db.approvalRequest.create({
    data: {
      permissionKey: ask.key,
      projectId: spec.projectId,
      actorType: 'SYSTEM',
      actorId: ask.component,
      onBehalfOfType: spec.onBehalfOf?.type ?? null,
      onBehalfOfId: spec.onBehalfOf?.id ?? null,
      origin: ask.origin,
      correlationId: randomUUID(),
      input: jsonValue(input),
      inputHash: approvalInputHash(input),
      requiredMode: spec.requiredMode ?? 'agent',
      policyId: null,
      onTimeout: 'reject',
      approverMustHoldAction: true,
      requireDistinctApprover: false,
      status: spec.status ?? 'pending',
      expiresAt: spec.expiresAt ?? new Date(createdAt.getTime() + HOUR_MS),
      settledAt: spec.settledAt ?? null,
      result: nullableJson(spec.result),
      createdAt,
    },
    select: { id: true },
  });

  for (const [index, decision] of (spec.decisions ?? []).entries()) {
    await db.approvalDecision.create({
      data: {
        requestId: request.id,
        deciderType: decision.deciderType,
        deciderId: decision.deciderId,
        decision: decision.decision,
        comment: decision.comment ?? null,
        params: nullableJson(decision.params),
        decidedAt: decision.decidedAt ?? new Date(createdAt.getTime() + (index + 1) * 1_000),
      },
    });
  }

  const link = spec.link ?? {};
  await db.fleetApprovalAsk.create({
    data: {
      requestId: request.id,
      kind: spec.kind,
      projectId: spec.projectId,
      jobId: link.jobId ?? null,
      leaseEpoch: link.leaseEpoch ?? null,
      naxAskId: link.naxAskId ?? null,
      budgetPolicyId: link.budgetPolicyId ?? null,
      resolvedBy: link.resolvedBy ?? null,
      outcome: nullableJson(link.outcome),
      // Production writes the link in the request's own transaction, so its `createdAt` is the ask's. A
      // seeded `createdAt` carries over, which is what a suite asserting the ask's age (US-011 AC-8) needs.
      ...(spec.createdAt === undefined ? {} : { createdAt: spec.createdAt }),
    },
  });

  return { requestId: request.id };
}
