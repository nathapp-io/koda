import { subject } from '@casl/ability';
import { KodaCaslAbilityFactory } from './koda-casl-ability.factory';
import { CaslPermission, CaslPermissionAction } from '@nathapp/nestjs-auth';
import { KodaAction } from './koda-action.enum';
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

    it('should have exactly 10 permission rules', async () => {
      const principal = makeUser({ role: 'ADMIN' });
      const perms = await factory.getPermissions(principal);

      expect(perms).toHaveLength(10);
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

    it('should grant IMPORT CodeIntel', () => {
      expect(permissionSet(perms)).toContain('import:CodeIntel');
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

  describe('runner permissions (fleet)', () => {
    it('grants a runner principal no permissions', async () => {
      const runner = { actorType: 'runner', id: 'r1', name: 'r', runnerName: 'r', labels: [], enabled: true, blacklisted: false, revoked: false, authorities: [] };
      await expect(factory.getPermissions(runner as never)).resolves.toEqual([]);
    });
  });

  describe('permission completeness', () => {
    it('MEMBER user has exactly 10 permission rules', async () => {
      const principal = makeUser({ role: 'MEMBER' });
      const perms = await factory.getPermissions(principal);

      expect(perms).toHaveLength(11);
    });

    it('agent with DEVELOPER role has base + derived permissions', async () => {
      const principal = makeAgent({ agentRoles: ['DEVELOPER'] });
      const perms = await factory.getPermissions(principal);

      const baseCount = 15; // AgentScope.read + 5 resource reads + ProjectContext.read + Comment CRUD.* + Label.manage + Ticket.create + Ticket.delete + CodeIntel.read + CodeIntel.import
      const derivedCount = 2; // TRANSITION Ticket + AstIndex.manage (both from DEVELOPER role)
      expect(perms).toHaveLength(baseCount + derivedCount);
    });
  });
});

describe('project-role permissions (#144)', () => {
  const factory = new KodaCaslAbilityFactory();
  const A = CaslPermissionAction;
  const T = KodaAction.TRANSITION as CaslPermissionAction;
  const U = KodaAction.UPDATE as CaslPermissionAction;

  type Row = [label: string, action: CaslPermissionAction, subjectType: string, admin: boolean, dev: boolean, viewer: boolean];
  const rows: Row[] = [
    ['read ticket', A.READ, 'Ticket', true, true, true],
    ['read label', A.READ, 'Label', true, true, true],
    ['read comment', A.READ, 'Comment', true, true, true],
    ['create ticket', A.CREATE, 'Ticket', true, true, false],
    ['update ticket', U, 'Ticket', true, true, false],
    ['transition ticket', T, 'Ticket', true, true, false],
    ['delete ticket', A.DELETE, 'Ticket', true, false, false],
    ['create label', A.CREATE, 'Label', true, true, false],
    ['update label', A.UPDATE, 'Label', true, false, false],
    ['delete label', A.DELETE, 'Label', true, false, false],
    ['create comment', A.CREATE, 'Comment', true, true, true],
    ['read code-intel', A.READ, 'CodeIntel', true, true, false],
  ];

  it.each(rows)('%s: ADMIN=%s DEVELOPER=%s VIEWER=%s', async (_label, action, subjectType, admin, dev, viewer) => {
    for (const [projectRole, expected] of [['ADMIN', admin], ['DEVELOPER', dev], ['VIEWER', viewer]] as const) {
      const ability = await factory.createForUser(makeUser({ projectRole }));
      expect({ projectRole, can: ability.can(action, subjectType) }).toEqual({ projectRole, can: expected });
    }
  });

  it('own comments: every project role may update and delete its own comment', async () => {
    for (const projectRole of ['ADMIN', 'DEVELOPER', 'VIEWER']) {
      const ability = await factory.createForUser(makeUser({ id: 'u1', projectRole }));
      const own = subject('Comment', { authorUserId: 'u1' });
      expect(ability.can(A.UPDATE, own)).toBe(true);
      expect(ability.can(A.DELETE, own)).toBe(true);
    }
  });

  it("another user's comment: only project ADMIN may delete it, nobody may edit it", async () => {
    const other = subject('Comment', { authorUserId: 'someone-else' });
    const admin = await factory.createForUser(makeUser({ id: 'u1', projectRole: 'ADMIN' }));
    const dev = await factory.createForUser(makeUser({ id: 'u1', projectRole: 'DEVELOPER' }));
    const viewer = await factory.createForUser(makeUser({ id: 'u1', projectRole: 'VIEWER' }));
    expect(admin.can(A.DELETE, other)).toBe(true);
    expect(admin.can(A.UPDATE, other)).toBe(false);
    expect(dev.can(A.DELETE, other)).toBe(false);
    expect(viewer.can(A.DELETE, other)).toBe(false);
  });

  it('an unrecognised legacy project role (AGENT, MEMBER, garbage) gets VIEWER rights only', async () => {
    for (const projectRole of ['AGENT', 'MEMBER', 'owner', '']) {
      const ability = await factory.createForUser(makeUser({ projectRole }));
      expect(ability.can(A.READ, 'Ticket')).toBe(true);
      expect(ability.can(A.CREATE, 'Ticket')).toBe(false);
      expect(ability.can(T, 'Ticket')).toBe(false);
      expect(ability.can(A.CREATE, 'Label')).toBe(false);
    }
  });

  it('no project role (route outside a project): a global MEMBER keeps today\'s global set', async () => {
    const ability = await factory.createForUser(makeUser());
    expect(ability.can(A.CREATE, 'Ticket')).toBe(true);
    expect(ability.can(T, 'Ticket')).toBe(false);
    expect(ability.can(A.READ, 'CodeIntel')).toBe(false);
  });

  it('global ADMIN is unaffected by a lower project role', async () => {
    const ability = await factory.createForUser(makeUser({ role: 'ADMIN', projectRole: 'VIEWER' }));
    expect(ability.can(A.DELETE, 'Ticket')).toBe(true);
    expect(ability.can(A.DELETE, 'Label')).toBe(true);
  });

  it('agents ignore projectRole entirely', async () => {
    const agent = { ...makeAgent({ agentRoles: ['REVIEWER'] }), projectRole: 'ADMIN' } as unknown as AgentPrincipal;
    const ability = await factory.createForUser(agent);
    expect(ability.can(T, 'Ticket')).toBe(true);
    expect(ability.can(U, 'Ticket')).toBe(false);
  });
});

describe('FleetJob (fleet S1, plan D9)', () => {
  const factory = new KodaCaslAbilityFactory();

  it.each([
    ['ADMIN', true, true],
    ['DEVELOPER', true, true],
    ['VIEWER', false, false],
  ])('project %s: create=%s update=%s', async (projectRole, create, update) => {
    const ability = await factory.createForUser(makeUser({ projectRole }));
    expect(ability.can(CaslPermissionAction.CREATE, 'FleetJob')).toBe(create);
    expect(ability.can(CaslPermissionAction.UPDATE, 'FleetJob')).toBe(update);
  });

  it('lets a global admin manage fleet jobs and never an agent', async () => {
    expect((await factory.createForUser(makeUser({ role: 'ADMIN' }))).can(CaslPermissionAction.CREATE, 'FleetJob')).toBe(true);
    const agent = await factory.createForUser(makeAgent({ agentRoles: ['DEVELOPER'] }));
    expect(agent.can(CaslPermissionAction.CREATE, 'FleetJob')).toBe(false);
    expect(agent.can(CaslPermissionAction.UPDATE, 'FleetJob')).toBe(false);
  });
});
