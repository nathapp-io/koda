import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { CodeIntelController } from '../../../src/code-intel/code-intel.controller';
import { AstIndexService } from '../../../src/code-intel/ast-index.service';
import { SymbolStore } from '../../../src/code-intel/symbol-store';
import { CodeGraphService } from '../../../src/code-intel/code-graph.service';
import { ProjectsService } from '../../../src/projects/projects.service';
import { ProjectAccessService } from '../../../src/projects/project-access.service';
import { PERMISSION_KEY } from '@nathapp/nestjs-auth';
import { PROJECT_PERMISSION_KEY } from '../../../src/projects/project-permission.decorator';
import { KodaAction } from '../../../src/auth/casl/koda-action.enum';
import type { CaslPermissionAction } from '@nathapp/nestjs-auth';

describe('CodeIntelController', () => {
  let controller: CodeIntelController;
  let astIndexService: jest.Mocked<AstIndexService>;

  const mockAstIndexService = {
    indexCommit: jest.fn(),
    getSymbol: jest.fn(),
    getCallers: jest.fn(),
    getCallees: jest.fn(),
  };

  const mockSymbolStore = {
    upsertSymbol: jest.fn(),
    findBySymbolId: jest.fn(),
    findCallers: jest.fn(),
    findCallees: jest.fn(),
    deleteByFile: jest.fn(),
  };

  const mockCodeGraph = {
    parseSourceFile: jest.fn(),
    extractSymbols: jest.fn(),
    extractCallers: jest.fn(),
    extractCallees: jest.fn(),
  };

  const mockProjectsService = {
    findProjectIdBySlug: jest.fn(),
    findBySlug: jest.fn(),
    assertProjectMembership: jest.fn(),
  };

  const mockProjectAccessService = {
    findProjectIdBySlug: jest.fn(),
    assertProjectMembership: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CodeIntelController],
      providers: [
        { provide: AstIndexService, useValue: mockAstIndexService },
        { provide: SymbolStore, useValue: mockSymbolStore },
        { provide: CodeGraphService, useValue: mockCodeGraph },
        { provide: ProjectsService, useValue: mockProjectsService },
        { provide: ProjectAccessService, useValue: mockProjectAccessService },
        Reflector,
      ],
    }).compile();

    controller = module.get<CodeIntelController>(CodeIntelController);
    astIndexService = module.get(AstIndexService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('AC-9: permission gating', () => {
    it('indexCommit endpoint should require MANAGE permission on AstIndex subject', () => {
      const permission = Reflect.getMetadata(PERMISSION_KEY, controller.indexCommit);
      expect(permission).toEqual([
        [KodaAction.MANAGE as CaslPermissionAction, 'AstIndex'],
      ]);
    });

    // Slice 4: the read routes moved from @RequiredPermission (global) to
    // @ProjectPermission — ProjectMembershipGuard resolves the query slug and
    // checks the #144 matrix against the caller's project role.
    it('searchSymbols endpoint should carry the project READ CodeIntel permission', () => {
      const permission = Reflect.getMetadata(PROJECT_PERMISSION_KEY, controller.searchSymbols);
      expect(permission).toEqual({
        permission: ['read' as CaslPermissionAction, 'CodeIntel'],
        exemptAgents: false,
      });
    });

    it('getSymbol endpoint should carry the project READ CodeIntel permission', () => {
      const permission = Reflect.getMetadata(PROJECT_PERMISSION_KEY, controller.getSymbol);
      expect(permission).toEqual({
        permission: ['read' as CaslPermissionAction, 'CodeIntel'],
        exemptAgents: false,
      });
    });

    it('getCallers endpoint should carry the project READ CodeIntel permission', () => {
      const permission = Reflect.getMetadata(PROJECT_PERMISSION_KEY, controller.getCallers);
      expect(permission).toEqual({
        permission: ['read' as CaslPermissionAction, 'CodeIntel'],
        exemptAgents: false,
      });
    });

    it('getCallees endpoint should carry the project READ CodeIntel permission', () => {
      const permission = Reflect.getMetadata(PROJECT_PERMISSION_KEY, controller.getCallees);
      expect(permission).toEqual({
        permission: ['read' as CaslPermissionAction, 'CodeIntel'],
        exemptAgents: false,
      });
    });
  });
});
