import { Injectable } from '@nestjs/common';
import type { IPageResult } from '@nathapp/nestjs-data';
import type { IPageOption } from '@nathapp/nestjs-common';
import { PermissionService, type DecidePatterns, type DecideScopes } from '../permissions/permission.service';
import type { PrincipalRef } from '../permissions/permissions.types';
import type { ApprovalRequestRecord, ApprovalRequestStatus, ApprovalDecisionRecord } from './domain/approval.domain';
import { ApprovalRequestNotFoundError } from './domain/approval.errors';
import { matchesDecidePattern } from './approval-eligibility';
import { PrismaApprovalRequestRepository } from './prisma-approval-request.repository';

export interface ApprovalRequestFilter {
  status?: ApprovalRequestStatus;
  projectId?: string;
  permissionKey?: string;
  /** Only requests whose actor or on-behalf-of principal is the caller. */
  mine?: boolean;
}
export interface ApprovalRequestDetail { request: ApprovalRequestRecord; decisions: ApprovalDecisionRecord[] }

@Injectable()
export class ApprovalRequestQueries {
  constructor(private readonly requests: PrismaApprovalRequestRepository, private readonly permissions: PermissionService) {}

  async list(principal: PrincipalRef, filter: ApprovalRequestFilter, page: IPageOption): Promise<IPageResult<ApprovalRequestRecord>> {
    const scopes = await this.permissions.approvalDecideScopes(principal);
    return this.requests.findVisiblePage({ principal, scopes }, filter, page);
  }

  /** Missing and invisible requests deliberately have the same error. */
  async get(principal: PrincipalRef, id: string): Promise<ApprovalRequestDetail> {
    const request = await this.requests.findById(id);
    if (!request) throw new ApprovalRequestNotFoundError(id);
    const scopes = await this.permissions.approvalDecideScopes(principal);
    if (!isVisible(request, principal, scopes)) throw new ApprovalRequestNotFoundError(id);
    return { request, decisions: await this.requests.findDecisions(id) };
  }

  /** Unscoped, for system readers such as the notification subscriber. */
  findById(id: string): Promise<ApprovalRequestRecord | null> {
    return this.requests.findById(id);
  }
}

function matches(patterns: DecidePatterns, key: string): boolean {
  return patterns === 'all' || patterns.some((pattern) => matchesDecidePattern(pattern, key));
}

function isVisible(request: ApprovalRequestRecord, principal: PrincipalRef, scopes: DecideScopes): boolean {
  return (request.actor.type === principal.type && request.actor.id === principal.id)
    || (request.onBehalfOf?.type === principal.type && request.onBehalfOf.id === principal.id)
    || scopes.everywhere
    || matches(scopes.global, request.permissionKey)
    || scopes.projects.some(({ projectId, patterns }) => projectId === request.projectId && matches(patterns, request.permissionKey));
}
