import { Test, TestingModule } from '@nestjs/testing';
import { KodaCaslAbilityFactory } from '../../src/auth/casl/koda-casl-ability.factory';
import type { KodaPrincipal, UserPrincipal, AgentPrincipal } from '../../src/auth/principal/koda-principal.types';

describe('KodaCaslAbilityFactory - AstIndex permissions', () => {
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

  const mockUserPrincipal = (role: 'MEMBER' | 'ADMIN'): UserPrincipal => ({
    id: 'user-123',
    sub: 'user-123',
    actorType: 'user',
    role,
    email: 'test@example.com',
    blacklisted: false,
    revoked: false,
    authorities: [],
    name: 'Test User',
  });

  const mockAgentPrincipal = (
    roles: ('DEVELOPER' | 'REVIEWER' | 'VERIFIER' | 'TRIAGER')[],
    capabilities: string[] = [],
  ): AgentPrincipal => ({
    id: 'agent-123',
    sub: 'agent-123',
    actorType: 'agent',
    slug: 'test-agent',
    status: 'ACTIVE',
    agentRoles: roles,
    capabilities,
    blacklisted: false,
    revoked: false,
    authorities: [],
    name: 'Test Agent',
  });

  describe('AC-9: factory rule grants MANAGE AstIndex to ADMIN users and DEVELOPER agents only', () => {
    it('ADMIN users should have MANAGE permission on AstIndex subject', async () => {
      const permissions = await factory.getPermissions(mockUserPrincipal('ADMIN'));

      expect(permissions).toContainEqual({
        action: 'manage',
        subject: 'AstIndex',
      });
    });

    it('MEMBER users should NOT have MANAGE permission on AstIndex subject', async () => {
      const permissions = await factory.getPermissions(mockUserPrincipal('MEMBER'));

      expect(permissions).not.toContainEqual({
        action: 'manage',
        subject: 'AstIndex',
      });
    });

    it('DEVELOPER agents should have MANAGE permission on AstIndex subject', async () => {
      const permissions = await factory.getPermissions(mockAgentPrincipal(['DEVELOPER']));

      expect(permissions).toContainEqual({
        action: 'manage',
        subject: 'AstIndex',
      });
    });

    it('REVIEWER agents should NOT have MANAGE permission on AstIndex subject', async () => {
      const permissions = await factory.getPermissions(mockAgentPrincipal(['REVIEWER']));

      expect(permissions).not.toContainEqual({
        action: 'manage',
        subject: 'AstIndex',
      });
    });

    it('VERIFIER agents should NOT have MANAGE permission on AstIndex subject', async () => {
      const permissions = await factory.getPermissions(mockAgentPrincipal(['VERIFIER']));

      expect(permissions).not.toContainEqual({
        action: 'manage',
        subject: 'AstIndex',
      });
    });

    it('TRIAGER agents should NOT have MANAGE permission on AstIndex subject', async () => {
      const permissions = await factory.getPermissions(mockAgentPrincipal(['TRIAGER']));

      expect(permissions).not.toContainEqual({
        action: 'manage',
        subject: 'AstIndex',
      });
    });

    it('agents without DEVELOPER role should not access AstIndex routes', async () => {
      const permissions = await factory.getPermissions(mockAgentPrincipal(['REVIEWER', 'VERIFIER', 'TRIAGER']));

      expect(permissions).not.toContainEqual({
        action: 'manage',
        subject: 'AstIndex',
      });
    });
  });
});
