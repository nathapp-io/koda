import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { CodeIntelController } from '../../../src/code-intel/code-intel.controller';
import { AstIndexService } from '../../../src/code-intel/ast-index.service';
import { SymbolStore } from '../../../src/code-intel/symbol-store';
import { CodeGraphService } from '../../../src/code-intel/code-graph.service';
import { PERMISSION_KEY } from '@nathapp/nestjs-auth';
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

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CodeIntelController],
      providers: [
        { provide: AstIndexService, useValue: mockAstIndexService },
        { provide: SymbolStore, useValue: mockSymbolStore },
        { provide: CodeGraphService, useValue: mockCodeGraph },
        Reflector,
      ],
    }).compile();

    controller = module.get<CodeIntelController>(CodeIntelController);
    astIndexService = module.get(AstIndexService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('AC-9: RequiredPermission gating', () => {
    it('indexCommit endpoint should require MANAGE permission on AstIndex subject', () => {
      const permission = Reflect.getMetadata(PERMISSION_KEY, controller.indexCommit);
      expect(permission).toEqual([
        [KodaAction.MANAGE as CaslPermissionAction, 'AstIndex'],
      ]);
    });

    it('getSymbol endpoint should require READ permission on CodeIntel subject', () => {
      const permission = Reflect.getMetadata(PERMISSION_KEY, controller.getSymbol);
      expect(permission).toEqual([
        [KodaAction.READ as CaslPermissionAction, 'CodeIntel'],
      ]);
    });

    it('getCallers endpoint should require READ permission on CodeIntel subject', () => {
      const permission = Reflect.getMetadata(PERMISSION_KEY, controller.getCallers);
      expect(permission).toEqual([
        [KodaAction.READ as CaslPermissionAction, 'CodeIntel'],
      ]);
    });

    it('getCallees endpoint should require READ permission on CodeIntel subject', () => {
      const permission = Reflect.getMetadata(PERMISSION_KEY, controller.getCallees);
      expect(permission).toEqual([
        [KodaAction.READ as CaslPermissionAction, 'CodeIntel'],
      ]);
    });
  });
});
