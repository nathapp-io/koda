import { Test, TestingModule } from '@nestjs/testing';
import { CaslPermissionAction } from '@nathapp/nestjs-auth';
import { KodaCaslAbilityFactory } from '../../src/auth/casl/koda-casl-ability.factory';
import type { UserPrincipal, AgentPrincipal } from '../../src/auth/principal/koda-principal.types';

describe('KodaCaslAbilityFactory - CodeIntel READ permissions (AC8)', () => {
  let factory: KodaCaslAbilityFactory;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [KodaCaslAbilityFactory],
    }).compile();

    factory = module.get<KodaCaslAbilityFactory>(KodaCaslAbilityFactory);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const mockUserPrincipal = (
    role: 'MEMBER' | 'ADMIN',
    extra: Record<string, unknown> = {},
  ): UserPrincipal =>
    ({
      id: 'user-123',
      sub: 'user-123',
      actorType: 'user',
      role,
      name: 'Test User',
      email: 'test@example.com',
      blacklisted: false,
      revoked: false,
      authorities: [],
      ...extra,
    }) as UserPrincipal;

  const mockAgentPrincipal = (
    roles: ('DEVELOPER' | 'REVIEWER' | 'VERIFIER' | 'TRIAGER')[],
  ): AgentPrincipal => ({
    id: 'agent-123',
    sub: 'agent-123',
    actorType: 'agent',
    slug: 'test-agent',
    status: 'ACTIVE',
    agentRoles: roles,
    capabilities: [],
    blacklisted: false,
    revoked: false,
    authorities: [],
    name: 'Test Agent',
  });

  describe('AC8: factory grants READ CodeIntel to ADMIN users, all agents, and DEVELOPER project role users', () => {
    it('ADMIN users should have READ CodeIntel', async () => {
      const permissions = await factory.getPermissions(mockUserPrincipal('ADMIN'));

      expect(permissions).toContainEqual({ action: CaslPermissionAction.READ, subject: 'CodeIntel' });
    });

    it('agents with no roles should have READ CodeIntel', async () => {
      const permissions = await factory.getPermissions(mockAgentPrincipal([]));

      expect(permissions).toContainEqual({ action: CaslPermissionAction.READ, subject: 'CodeIntel' });
    });

    it('agents with DEVELOPER role should have READ CodeIntel', async () => {
      const permissions = await factory.getPermissions(mockAgentPrincipal(['DEVELOPER']));

      expect(permissions).toContainEqual({ action: CaslPermissionAction.READ, subject: 'CodeIntel' });
    });

    /**
     * FAILING TEST — documents spec-correct behavior for the AC8 bug.
     *
     * Bug (koda-casl-ability.factory.ts:52): the non-ADMIN branch does not grant
     * READ CodeIntel to users with DEVELOPER project role. According to AC8, the
     * factory must grant READ CodeIntel to ADMIN users, all agents, AND users
     * carrying a DEVELOPER project role.
     *
     * Fix: extend UserPrincipal with a projectRole field (or equivalent), then
     * add a READ CodeIntel grant in the non-ADMIN branch when projectRole is
     * 'DEVELOPER'.
     *
     * This test will fail until that change is implemented.
     */
    it('users with DEVELOPER project role should have READ CodeIntel', async () => {
      const principal = mockUserPrincipal('MEMBER', { projectRole: 'DEVELOPER' });
      const permissions = await factory.getPermissions(principal);

      expect(permissions).toContainEqual({ action: CaslPermissionAction.READ, subject: 'CodeIntel' });
    });

    it('MEMBER users without a DEVELOPER project role should NOT have READ CodeIntel', async () => {
      const permissions = await factory.getPermissions(mockUserPrincipal('MEMBER'));

      expect(permissions).not.toContainEqual({ action: CaslPermissionAction.READ, subject: 'CodeIntel' });
    });
  });
});
