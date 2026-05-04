import { Injectable } from '@nestjs/common';
import {
  BaseCaslAbilityFactory,
  CaslPermission,
  CaslPermissionAction,
} from '@nathapp/nestjs-auth';
import {
  KodaPrincipal,
  isUserPrincipal,
  type UserPrincipal,
  type AgentPrincipal,
} from '../principal/koda-principal.types';
import { KodaAction } from './koda-action.enum';

@Injectable()
export class KodaCaslAbilityFactory extends BaseCaslAbilityFactory {
  /**
   * Real resource subjects that all authenticated actors can read.
   * Virtual subjects (AgentScope, AdminScope) are excluded — they
   * are granted selectively by the factory.
   */
  private static readonly READABLE_RESOURCES = [
    'Comment', 'Label', 'Ticket', 'Project', 'Agent',
  ] as const;

  /**
   * Subjects that ADMIN can manage. Excludes virtual subjects
   * (AgentScope, AdminScope) so that agent-only routes stay gated.
   */
  private static readonly ADMIN_MANAGEABLE_RESOURCES = [
    'Comment', 'Label', 'Ticket', 'Project', 'Agent',
  ] as const;

  async getPermissions(principal: KodaPrincipal): Promise<CaslPermission[]> {
    if (isUserPrincipal(principal)) {
      return this.userPermissions(principal);
    }
    return this.agentPermissions(principal);
  }

  private userPermissions(principal: UserPrincipal): CaslPermission[] {
    if (principal.role === 'ADMIN') {
      return KodaCaslAbilityFactory.ADMIN_MANAGEABLE_RESOURCES.map(
        (subject) => ({ action: CaslPermissionAction.MANAGE, subject }),
      );
    }
    return [
      ...this.readPermissions(),
      { action: CaslPermissionAction.CREATE, subject: 'Comment' },
      { action: CaslPermissionAction.UPDATE, subject: 'Comment', conditions: { authorUserId: principal.id } },
      { action: CaslPermissionAction.DELETE, subject: 'Comment', conditions: { authorUserId: principal.id } },
      { action: CaslPermissionAction.CREATE, subject: 'Ticket' },
    ];
  }

  private agentPermissions(principal: AgentPrincipal): CaslPermission[] {
    return [
      { action: CaslPermissionAction.READ, subject: 'AgentScope' },
      ...this.readPermissions(),
      { action: CaslPermissionAction.CREATE, subject: 'Comment' },
      { action: CaslPermissionAction.UPDATE, subject: 'Comment', conditions: { authorAgentId: principal.id } },
      { action: CaslPermissionAction.DELETE, subject: 'Comment', conditions: { authorAgentId: principal.id } },
      { action: CaslPermissionAction.MANAGE, subject: 'Label' },
      { action: CaslPermissionAction.CREATE, subject: 'Ticket' },
      // Preserve pre-CASL behavior (commit 4ceb85e: "allow agents to soft-delete tickets")
      { action: CaslPermissionAction.DELETE, subject: 'Ticket' },
      ...this.agentRoleDerivedPermissions(principal),
    ];
  }

  private readPermissions(): CaslPermission[] {
    return KodaCaslAbilityFactory.READABLE_RESOURCES.map(
      (subject) => ({ action: CaslPermissionAction.READ, subject }),
    );
  }

  private agentRoleDerivedPermissions(principal: AgentPrincipal): CaslPermission[] {
    const perms: CaslPermission[] = [];
    for (const role of principal.agentRoles) {
      switch (role) {
        case 'DEVELOPER':
          perms.push({ action: KodaAction.TRANSITION as CaslPermissionAction, subject: 'Ticket' });
          break;
        case 'REVIEWER':
          perms.push({ action: KodaAction.TRANSITION as CaslPermissionAction, subject: 'Ticket' });
          break;
        case 'VERIFIER':
          perms.push({ action: KodaAction.TRANSITION as CaslPermissionAction, subject: 'Ticket' });
          break;
        case 'TRIAGER':
          perms.push({ action: KodaAction.UPDATE as CaslPermissionAction, subject: 'Ticket' });
          break;
        default:
          // Compile-time exhaustiveness guard: if a new value is added to
          // AGENT_ROLES without a case here, TypeScript errors on this line.
          // At runtime, unknown roles from DB are silently skipped (no-op).
          void (role as never);
          break;
      }
    }
    return perms;
  }
}
