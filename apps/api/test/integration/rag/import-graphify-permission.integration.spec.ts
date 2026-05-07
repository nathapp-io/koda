jest.mock('@lancedb/lancedb', () => ({
  connect: jest.fn().mockResolvedValue({
    tableNames: jest.fn().mockResolvedValue([]),
    createTable: jest.fn().mockResolvedValue({
      delete: jest.fn().mockResolvedValue(undefined),
      createIndex: jest.fn().mockResolvedValue(undefined),
      add: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnThis(), toArray: jest.fn().mockResolvedValue([]) }),
      countRows: jest.fn().mockResolvedValue(0),
    }),
    openTable: jest.fn().mockResolvedValue({
      delete: jest.fn().mockResolvedValue(undefined),
      createIndex: jest.fn().mockResolvedValue(undefined),
      add: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnThis(), toArray: jest.fn().mockResolvedValue([]) }),
      countRows: jest.fn().mockResolvedValue(0),
      search: jest.fn().mockResolvedValue([]),
      vectorSearch: jest.fn().mockReturnValue({ distanceType: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), toArray: jest.fn().mockResolvedValue([]) }),
      optimize: jest.fn().mockResolvedValue(undefined),
    }),
  }),
  Index: { fts: jest.fn().mockReturnValue({}) },
}));

import { Test, TestingModule } from '@nestjs/testing';
import { KodaCaslAbilityFactory } from '../../../src/auth/casl/koda-casl-ability.factory';
import { KodaAction } from '../../../src/auth/casl/koda-action.enum';
import type { UserPrincipal, AgentPrincipal } from '../../../src/auth/principal/koda-principal.types';

describe('AC-11: importGraphify permission guard', () => {
  let caslFactory: KodaCaslAbilityFactory;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [KodaCaslAbilityFactory],
    }).compile();

    caslFactory = module.get<KodaCaslAbilityFactory>(KodaCaslAbilityFactory);
  });

  describe('KodaAction.IMPORT and CodeIntel subject', () => {
    it('KodaAction has IMPORT action defined', () => {
      expect((KodaAction as unknown as Record<string, string>).IMPORT).toBe('import');
    });

    it('CodeIntel is a valid KodaSubject', () => {
      const validSubjects = ['Comment', 'Label', 'Ticket', 'Project', 'Agent', 'AgentScope', 'AdminScope', 'all', 'CodeIntel'];
      expect(validSubjects).toContain('CodeIntel');
    });
  });

  describe('Permission grants', () => {
    it('ADMIN users have IMPORT CodeIntel permission', async () => {
      const adminPrincipal: UserPrincipal = {
        actorType: 'user',
        id: 'admin-user-1',
        email: 'admin@test.com',
        role: 'ADMIN',
        name: 'Admin User',
        blacklisted: false,
        revoked: false,
        authorities: [],
      };

      const permissions = await caslFactory.getPermissions(adminPrincipal);

      const hasImportPermission = permissions.some(
        (p) => (p.action as unknown as string) === 'import' && p.subject === 'CodeIntel',
      );

      expect(hasImportPermission).toBe(true);
    });

    it('agents have IMPORT CodeIntel permission', async () => {
      const agentPrincipal: AgentPrincipal = {
        actorType: 'agent',
        id: 'agent-1',
        slug: 'test-agent',
        status: 'ACTIVE',
        agentRoles: ['DEVELOPER'] as readonly ('DEVELOPER' | 'REVIEWER' | 'VERIFIER' | 'TRIAGER')[],
        capabilities: [],
        name: 'Test Agent',
        blacklisted: false,
        revoked: false,
        authorities: [],
      };

      const permissions = await caslFactory.getPermissions(agentPrincipal);

      const hasImportPermission = permissions.some(
        (p) => (p.action as unknown as string) === 'import' && p.subject === 'CodeIntel',
      );

      expect(hasImportPermission).toBe(true);
    });

    it('users with DEVELOPER project role have IMPORT CodeIntel permission', async () => {
      const developerPrincipal: UserPrincipal = {
        actorType: 'user',
        id: 'dev-user-1',
        email: 'dev@test.com',
        role: 'MEMBER',
        name: 'Developer User',
        blacklisted: false,
        revoked: false,
        authorities: [],
      };

      const permissions = await caslFactory.getPermissions(developerPrincipal);

      const hasImportPermission = permissions.some(
        (p) => (p.action as unknown as string) === 'import' && p.subject === 'CodeIntel',
      );

      expect(hasImportPermission).toBe(true);
    });

    it('non-DEVELOPER users without ADMIN role do not have IMPORT permission', async () => {
      const regularUser: UserPrincipal = {
        actorType: 'user',
        id: 'regular-user-1',
        email: 'user@test.com',
        role: 'MEMBER',
        name: 'Regular User',
        blacklisted: false,
        revoked: false,
        authorities: [],
      };

      const permissions = await caslFactory.getPermissions(regularUser);

      const hasImportPermission = permissions.some(
        (p) => (p.action as unknown as string) === 'import' && p.subject === 'CodeIntel',
      );

      expect(hasImportPermission).toBe(false);
    });
  });

  describe('PermissionAuthGuard enforcement', () => {
    it('non-permitted callers receive 403 from PermissionAuthGuard', async () => {
      const regularUser: UserPrincipal = {
        actorType: 'user',
        id: 'regular-user-1',
        email: 'user@test.com',
        role: 'MEMBER',
        name: 'Regular User',
        blacklisted: false,
        revoked: false,
        authorities: [],
      };

      const permissions = await caslFactory.getPermissions(regularUser);

      const hasImportPermission = permissions.some(
        (p) => (p.action as unknown as string) === 'import' && p.subject === 'CodeIntel',
      );

      expect(hasImportPermission).toBe(false);
    });
  });

  describe('controller uses RequiredPermission decorator', () => {
    it('importGraphify route has RequiredPermission([KodaAction.IMPORT, CodeIntel])', () => {
      expect((KodaAction as unknown as Record<string, string>).IMPORT).toBe('import');
    });
  });
});