import type { Prisma } from '../generated/prisma/client';
import type { DecidePatterns, DecideScopes } from '../permissions/permission.service';
import type { PrincipalRef } from '../permissions/permissions.types';
import type { ApprovalRequestFilter } from './approval-request.queries';

/** Shared inbox visibility: own requests plus the caller's exact/narrowed decide scopes. */
export function visibleRequestWhere(
  visibility: { principal: PrincipalRef; scopes: DecideScopes },
  filter: ApprovalRequestFilter,
): Prisma.ApprovalRequestWhereInput {
  const { principal, scopes } = visibility;
  const clauses: Prisma.ApprovalRequestWhereInput[] = [
    { actorType: principal.type, actorId: principal.id },
    { onBehalfOfType: principal.type, onBehalfOfId: principal.id },
  ];
  const unrestricted = !filter.mine && (scopes.everywhere || scopes.global === 'all');
  if (!filter.mine && !unrestricted) {
    clauses.push(...patternClauses(scopes.global));
    for (const { projectId, patterns } of scopes.projects) {
      clauses.push(...patternClauses(patterns).map((keyClause) => ({ ...keyClause, projectId })));
    }
  }
  return {
    ...(filter.status !== undefined ? { status: filter.status } : {}),
    ...(filter.projectId !== undefined ? { projectId: filter.projectId } : {}),
    ...(filter.permissionKey !== undefined ? { permissionKey: filter.permissionKey } : {}),
    ...(filter.jobId !== undefined ? { fleetAsk: { is: { jobId: filter.jobId } } } : {}),
    // Do not use OR: [{}] for unrestricted scopes: Prisma elides empty OR branches.
    ...(!unrestricted ? { OR: clauses } : {}),
  };
}

function patternClauses(patterns: DecidePatterns): Prisma.ApprovalRequestWhereInput[] {
  if (patterns === 'all') return [{}];
  return patterns.map((pattern) => ({
    permissionKey: pattern.endsWith('.*') ? { startsWith: pattern.slice(0, -1) } : pattern,
  }));
}
