import { KodaCaslAbilityFactory } from './koda-casl-ability.factory';
import { CaslPermission, CaslPermissionAction } from '@nathapp/nestjs-auth';
import type { UserPrincipal, AgentPrincipal } from '../principal/koda-principal.types';

function makeUser(overrides: Partial<UserPrincipal> = {}): UserPrincipal {
  return {
    id: 'user-1',
    name: 'Test User',
    actorType: 'user',
    role: 'MEMBER',
    email: 'user@test.com',
    blacklisted: false,
    revoked: false,
    authorities: [],
    ...overrides,
  };
}

function makeAgent(overrides: Partial<AgentPrincipal> = {}): AgentPrincipal {
  return {
    id: 'agent-1',
    name: 'Test Agent',
    actorType: 'agent',
    slug: 'test-agent',
    status: 'ACTIVE',
    agentRoles: [],
    capabilities: [],
    blacklisted: false,
    revoked: false,
    authorities: [],
    ...overrides,
  };
}

function permissionSet(perms: CaslPermission[]): string[] {
  return perms.map((p) => `${p.action}:${p.subject}${p.conditions ? ` (conditions)` : ''}`);
}

describe('KodaCaslAbilityFactory', () => {
  let factory: KodaCaslAbilityFactory;

  beforeEach(() => {
    factory = new KodaCaslAbilityFactory();
  });

  describe('ADMIN user permissions', () => {
    it('should grant manage on all real resources', async () => {
      const principal = makeUser({ role: 'ADMIN' });
      const perms = await factory.getPermissions(principal);

      expect(perms).toContainEqual({ action: CaslPermissionAction.MANAGE, subject: 'Comment' });
      expect(perms).toContainEqual({ action: CaslPermissionAction.MANAGE, subject: 'Label' });
      expect(perms).toContainEqual({ action: CaslPermissionAction.MANAGE, subject: 'Ticket' });
      expect(perms).toContainEqual({ action: CaslPermissionAction.MANAGE, subject: 'Project' });
      expect(perms).toContainEqual({ action: CaslPermissionAction.MANAGE, subject: 'Agent' });
    });

    it('should NOT grant access to AgentScope', async () => {
      const principal = makeUser({ role: 'ADMIN' });
      const perms = await factory.getPermissions(principal);

      expect(permissionSet(perms)).not.toContain('read:AgentScope');
      expect(permissionSet(perms)).not.toContain('manage:AgentScope');
    });

    it('should have exactly 5 permission rules', async () => {
      const principal = makeUser({ role: 'ADMIN' });
      const perms = await factory.getPermissions(principal);

      expect(perms).toHaveLength(5);
    });
  });

  describe('MEMBER user permissions', () => {
    let perms: CaslPermission[];

    beforeEach(async () => {
      const principal = makeUser({ role: 'MEMBER' });
      perms = await factory.getPermissions(principal);
    });

    it('should grant read for all resource subjects', () => {
      expect(perms).toContainEqual({ action: CaslPermissionAction.READ, subject: 'Comment' });
      expect(perms).toContainEqual({ action: CaslPermissionAction.READ, subject: 'Label' });
      expect(perms).toContainEqual({ action: CaslPermissionAction.READ, subject: 'Ticket' });
      expect(perms).toContainEqual({ action: CaslPermissionAction.READ, subject: 'Project' });
      expect(perms).toContainEqual({ action: CaslPermissionAction.READ, subject: 'Agent' });
    });

    it('should NOT grant READ AgentScope (virtual subject)', () => {
      expect(permissionSet(perms)).not.toContain('read:AgentScope');
    });

    it('should grant create Comment', () => {
      expect(perms).toContainEqual({ action: CaslPermissionAction.CREATE, subject: 'Comment' });
    });

    it('should grant update own Comment with conditions', () => {
      expect(perms).toContainEqual({
        action: CaslPermissionAction.UPDATE,
        subject: 'Comment',
        conditions: { authorUserId: 'user-1' },
      });
    });

    it('should grant delete own Comment with conditions', () => {
      expect(perms).toContainEqual({
        action: CaslPermissionAction.DELETE,
        subject: 'Comment',
        conditions: { authorUserId: 'user-1' },
      });
    });

    it('should grant create Ticket', () => {
      expect(perms).toContainEqual({ action: CaslPermissionAction.CREATE, subject: 'Ticket' });
    });

    it('should NOT grant MANAGE Label', () => {
      expect(permissionSet(perms)).not.toContain('manage:Label');
    });

    it('should NOT grant DELETE Ticket', () => {
      expect(permissionSet(perms)).not.toContain('delete:Ticket');
    });
  });

  describe('agent permissions (no roles)', () => {
    let perms: CaslPermission[];

    beforeEach(async () => {
      const principal = makeAgent();
      perms = await factory.getPermissions(principal);
    });

    it('should grant READ AgentScope', () => {
      expect(perms).toContainEqual({ action: CaslPermissionAction.READ, subject: 'AgentScope' });
    });

    it('should grant read for all resource subjects', () => {
      expect(perms).toContainEqual({ action: CaslPermissionAction.READ, subject: 'Comment' });
      expect(perms).toContainEqual({ action: CaslPermissionAction.READ, subject: 'Label' });
      expect(perms).toContainEqual({ action: CaslPermissionAction.READ, subject: 'Ticket' });
      expect(perms).toContainEqual({ action: CaslPermissionAction.READ, subject: 'Project' });
      expect(perms).toContainEqual({ action: CaslPermissionAction.READ, subject: 'Agent' });
    });

    it('should grant create Comment', () => {
      expect(perms).toContainEqual({ action: CaslPermissionAction.CREATE, subject: 'Comment' });
    });

    it('should grant update own Comment with conditions', () => {
      expect(perms).toContainEqual({
        action: CaslPermissionAction.UPDATE,
        subject: 'Comment',
        conditions: { authorAgentId: 'agent-1' },
      });
    });

    it('should grant delete own Comment with conditions', () => {
      expect(perms).toContainEqual({
        action: CaslPermissionAction.DELETE,
        subject: 'Comment',
        conditions: { authorAgentId: 'agent-1' },
      });
    });

    it('should grant MANAGE Label', () => {
      expect(perms).toContainEqual({ action: CaslPermissionAction.MANAGE, subject: 'Label' });
    });

    it('should grant create Ticket', () => {
      expect(perms).toContainEqual({ action: CaslPermissionAction.CREATE, subject: 'Ticket' });
    });

    // Preserves pre-CASL behavior (commit 4ceb85e: "allow agents to soft-delete tickets").
    // The original inline check only blocked non-ADMIN users; agents fell outside the predicate.
    it('should grant DELETE Ticket (no conditions)', () => {
      expect(perms).toContainEqual({ action: CaslPermissionAction.DELETE, subject: 'Ticket' });
    });
  });

  describe('agent role-derived permissions', () => {
    it('DEVELOPER grants TRANSITION Ticket', async () => {
      const principal = makeAgent({ agentRoles: ['DEVELOPER'] });
      const perms = await factory.getPermissions(principal);

      expect(permissionSet(perms)).toContain('transition:Ticket');
    });

    it('REVIEWER grants TRANSITION Ticket', async () => {
      const principal = makeAgent({ agentRoles: ['REVIEWER'] });
      const perms = await factory.getPermissions(principal);

      expect(permissionSet(perms)).toContain('transition:Ticket');
    });

    it('VERIFIER grants TRANSITION Ticket', async () => {
      const principal = makeAgent({ agentRoles: ['VERIFIER'] });
      const perms = await factory.getPermissions(principal);

      expect(permissionSet(perms)).toContain('transition:Ticket');
    });

    it('TRIAGER grants UPDATE Ticket', async () => {
      const principal = makeAgent({ agentRoles: ['TRIAGER'] });
      const perms = await factory.getPermissions(principal);

      expect(permissionSet(perms)).toContain('update:Ticket');
    });

    it('agent with multiple roles gets all derived permissions', async () => {
      const principal = makeAgent({ agentRoles: ['DEVELOPER', 'TRIAGER'] });
      const perms = await factory.getPermissions(principal);

      expect(permissionSet(perms)).toContain('transition:Ticket');
      expect(permissionSet(perms)).toContain('update:Ticket');
    });

    it('agent with no roles does not get TRANSITION Ticket', async () => {
      const principal = makeAgent({ agentRoles: [] });
      const perms = await factory.getPermissions(principal);

      expect(permissionSet(perms)).not.toContain('transition:Ticket');
      expect(permissionSet(perms)).not.toContain('update:Ticket');
    });
  });

  describe('permission completeness', () => {
    it('MEMBER user has exactly 9 permission rules', async () => {
      const principal = makeUser({ role: 'MEMBER' });
      const perms = await factory.getPermissions(principal);

      expect(perms).toHaveLength(9);
    });

    it('agent with DEVELOPER role has base + derived permissions', async () => {
      const principal = makeAgent({ agentRoles: ['DEVELOPER'] });
      const perms = await factory.getPermissions(principal);

      const baseCount = 12; // AgentScope.read + 5 resource reads + Comment CRUD.* + Label.manage + Ticket.create + Ticket.delete
      const derivedCount = 1; // TRANSITION Ticket
      expect(perms).toHaveLength(baseCount + derivedCount);
    });
  });
});
