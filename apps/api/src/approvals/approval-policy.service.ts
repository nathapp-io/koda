import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { TRANSACTION_MANAGER, type IRepository, type ITransactionManager } from '@nathapp/nestjs-data';
import { currentContext } from '../action-context/action-context';
import { AuditRecorder } from '../audit/audit-recorder.service';
import { PermissionService } from '../permissions/permission.service';
import { policySelector, validateApprovalPolicy } from './approval-policy.validation';
import { APPROVAL_POLICY_REPOSITORY, type ApprovalPolicyInput, type ApprovalPolicyRecord } from './domain/approval.domain';
import { ApprovalPolicyConflictError, ApprovalPolicyNotFoundError, ApprovalPolicySelfApplicationError, InvalidApprovalPolicyError } from './domain/approval.errors';
import { PrismaApprovalPolicyRepository } from './prisma-approval-policy.repository';

type PolicyPatch = Partial<Omit<ApprovalPolicyInput, 'projectId' | 'permissionPattern' | 'appliesTo'>>;
const MUTABLE_FIELDS = ['mode', 'timeoutSec', 'onTimeout', 'requiredApprovals', 'approverMustHoldAction', 'requireDistinctApprover'] as const;

@Injectable()
export class ApprovalPolicyService {
  constructor(
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    @Inject(APPROVAL_POLICY_REPOSITORY) private readonly policies: IRepository<ApprovalPolicyRecord>,
    private readonly queries: PrismaApprovalPolicyRepository,
    private readonly permissions: PermissionService,
    private readonly audit: AuditRecorder,
  ) {}

  create(input: ApprovalPolicyInput): Promise<ApprovalPolicyRecord> {
    return this.txManager.run(async () => {
      this.validate(input);
      await this.assertNotSelfApplying(input);
      const selector = policySelector(input);
      if (await this.queries.findBySelector(selector)) throw new ApprovalPolicyConflictError(selector);
      const actor = this.actor();
      const subject = input.appliesTo;
      const now = new Date();
      const row = await this.policies.create({
        id: randomUUID(), selector, projectId: input.projectId, permissionPattern: input.permissionPattern,
        principalType: subject.kind === 'type' || subject.kind === 'principal' ? subject.principalType : null,
        principalId: subject.kind === 'principal' ? subject.principalId : null,
        roleId: subject.kind === 'role' ? subject.roleId : null,
        mode: input.mode, timeoutSec: input.timeoutSec ?? null, onTimeout: input.onTimeout ?? 'reject',
        requiredApprovals: input.requiredApprovals ?? 1,
        approverMustHoldAction: input.approverMustHoldAction ?? true,
        requireDistinctApprover: input.requireDistinctApprover ?? false,
        updatedByType: actor.type, updatedById: actor.id, createdAt: now, updatedAt: now,
      });
      await this.record(row, `created ${row.permissionPattern} ${row.mode}`);
      return row;
    });
  }

  update(id: string, patch: PolicyPatch): Promise<ApprovalPolicyRecord> {
    return this.txManager.run(async () => {
      const stored = await this.requirePolicy(id);
      // Explicit allowlist keeps identity immutable even for untyped callers. Undefined means absent.
      const changes: PolicyPatch = {};
      for (const field of MUTABLE_FIELDS) {
        if (patch[field] !== undefined) Object.assign(changes, { [field]: patch[field] });
      }
      const merged = { ...stored, ...changes };
      const input = this.inputOf(merged);
      this.validate(input);
      await this.assertNotSelfApplying(input);
      const changed = MUTABLE_FIELDS.filter((field) => merged[field] !== stored[field]);
      const actor = this.actor();
      const row = await this.policies.update(id, {
        ...changes, updatedByType: actor.type, updatedById: actor.id, updatedAt: new Date(),
      });
      await this.record(row, `updated ${changed.join(',')}`);
      return row;
    });
  }

  remove(id: string): Promise<void> {
    return this.txManager.run(async () => {
      const row = await this.requirePolicy(id);
      await this.assertNotSelfApplying(this.inputOf(row));
      this.actor();
      await this.policies.delete(id);
      await this.record(row, `deleted ${row.permissionPattern}`);
    });
  }

  async list(filter: { projectId?: string | null; permissionPattern?: string }, page: { current: number; size: number }): Promise<ApprovalPolicyRecord[]> {
    return (await this.queries.findPage(filter, page)).records;
  }

  private actor() {
    const context = currentContext();
    if (!context) throw new Error('approval policy write needs an action context');
    return context.actor;
  }

  private validate(input: ApprovalPolicyInput): void {
    const violation = validateApprovalPolicy(input);
    if (violation) throw new InvalidApprovalPolicyError(violation);
  }

  private async requirePolicy(id: string): Promise<ApprovalPolicyRecord> {
    const row = await this.policies.findById(id);
    if (!row) throw new ApprovalPolicyNotFoundError(id);
    return row;
  }

  private inputOf(row: ApprovalPolicyRecord): ApprovalPolicyInput {
    const appliesTo: ApprovalPolicyInput['appliesTo'] = row.roleId !== null
      ? { kind: 'role', roleId: row.roleId }
      : row.principalId !== null && (row.principalType === 'USER' || row.principalType === 'AGENT')
        ? { kind: 'principal', principalType: row.principalType, principalId: row.principalId }
        : row.principalType !== null ? { kind: 'type', principalType: row.principalType } : { kind: 'all' };
    return { ...row, appliesTo };
  }

  private async assertNotSelfApplying(input: ApprovalPolicyInput): Promise<void> {
    const actor = this.actor();
    if (actor.type !== 'AGENT') return;
    const subject = input.appliesTo;
    let applies = false;
    switch (subject.kind) {
      case 'all': applies = true; break;
      case 'type': applies = subject.principalType === 'AGENT'; break;
      case 'principal': applies = subject.principalType === 'AGENT' && subject.principalId === actor.id; break;
      case 'role': {
        const principal = { type: actor.type, id: actor.id };
        const roles = input.projectId === null
          ? await this.permissions.roleIdsAnywhere(principal)
          : await this.permissions.roleIdsAt(principal, { projectId: input.projectId });
        applies = roles.includes(subject.roleId);
        break;
      }
    }
    if (applies) throw new ApprovalPolicySelfApplicationError(policySelector(input));
  }

  private record(row: ApprovalPolicyRecord, summary: string): Promise<void> {
    return this.audit.record({ key: 'approval.policy.manage', resourceType: 'approval-policy', resourceId: row.id, projectId: row.projectId, summary });
  }
}
