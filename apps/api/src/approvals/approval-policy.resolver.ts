import { Inject, Injectable } from '@nestjs/common';
import { findCatalogEntry, type ApprovalMode } from '../permissions/catalog';
import { PermissionService } from '../permissions/permission.service';
import { APPROVAL_MODE_RANK, strictestMode } from './domain/approval-mode';
import {
  APPROVAL_POLICY_REPOSITORY,
  type ApprovalPolicyRecord,
  type ApprovalSubjectType,
} from './domain/approval.domain';
import type { PrismaApprovalPolicyRepository } from './prisma-approval-policy.repository';

export interface ApprovalSubject { type: ApprovalSubjectType | 'SYSTEM'; id: string }
export interface ResolvedApproval {
  mode: ApprovalMode;
  floor: ApprovalMode;
  policy: ApprovalPolicyRecord | null;
  source: 'not-approvable' | 'policy' | 'default';
}
export const ASSISTANT_DEFAULT_MODE: ApprovalMode = 'human';

@Injectable()
export class ApprovalPolicyResolver {
  constructor(
    @Inject(APPROVAL_POLICY_REPOSITORY)
    private readonly policies: Pick<PrismaApprovalPolicyRepository, 'findCandidates'>,
    @Inject(PermissionService)
    private readonly permissions: Pick<PermissionService, 'roleIdsAt'>,
  ) {}

  async resolve(input: { key: string; projectId: string | null; subject: ApprovalSubject }): Promise<ResolvedApproval> {
    const { key, projectId, subject } = input;
    const entry = findCatalogEntry(key);
    if (!entry) throw new Error(`unknown permission key: ${key}`);
    if (!entry.approval.approvable) {
      return { mode: 'none', floor: 'none', policy: null, source: 'not-approvable' };
    }

    const [candidates, roleIds] = await Promise.all([
      this.policies.findCandidates(key, projectId),
      subject.type === 'ASSISTANT' || subject.type === 'SYSTEM'
        ? Promise.resolve([] as string[])
        : this.permissions.roleIdsAt({ type: subject.type, id: subject.id }, projectId === null ? 'global' : { projectId }),
    ]);
    // Repository candidates already match the key and project. Rank subjects before patterns:
    // even a project-wide wildcard precedes an exact global principal override.
    const ranked = candidates.flatMap((policy) => {
      const subjectRank = applicableSubjectRank(policy, subject, roleIds);
      return subjectRank === null ? [] : [{ policy, tier: (policy.projectId === null ? 4 : 0) + subjectRank }];
    });
    ranked.sort((a, b) => a.tier - b.tier ||
      specificity(b.policy.permissionPattern, key) - specificity(a.policy.permissionPattern, key) ||
      APPROVAL_MODE_RANK[b.policy.mode] - APPROVAL_MODE_RANK[a.policy.mode] ||
      compareIds(a.policy.id, b.policy.id));

    const policy = ranked[0]?.policy ?? null;
    const chosen = policy?.mode ?? (subject.type === 'ASSISTANT' ? ASSISTANT_DEFAULT_MODE : entry.approval.default);
    return {
      mode: strictestMode(chosen, entry.approval.floor), floor: entry.approval.floor,
      policy, source: policy ? 'policy' : 'default',
    };
  }
}

function applicableSubjectRank(policy: ApprovalPolicyRecord, subject: ApprovalSubject, roleIds: string[]): number | null {
  if (subject.type === 'SYSTEM') {
    return policy.principalId === null && policy.roleId === null && policy.principalType === null ? 3 : null;
  }
  if (policy.principalId !== null) {
    return policy.principalType === subject.type && policy.principalId === subject.id ? 0 : null;
  }
  if (policy.roleId !== null) {
    return subject.type !== 'ASSISTANT' && roleIds.includes(policy.roleId) ? 1 : null;
  }
  if (policy.principalType !== null) return policy.principalType === subject.type ? 2 : null;
  return subject.type === 'ASSISTANT' ? null : 3;
}

function specificity(pattern: string, key: string): number {
  return pattern === key ? key.length + 1 : pattern.length;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
