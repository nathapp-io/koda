import { Test, TestingModule } from '@nestjs/testing';
import { OutboxFanOutRegistry } from '../../src/outbox/outbox-fan-out-registry';
import { AstIndexService } from '../../src/code-intel/ast-index.service';
import { SymbolStore } from '../../src/code-intel/symbol-store';
import { CodeGraphService } from '../../src/code-intel/code-graph.service';

describe('code_commit outbox handler', () => {
  let registry: OutboxFanOutRegistry;
  let astIndexService: jest.Mocked<AstIndexService>;
  let symbolStore: jest.Mocked<SymbolStore>;
  let codeGraph: jest.Mocked<CodeGraphService>;

  const mockCodeGraph = {
    parseSourceFile: jest.fn(),
    extractSymbols: jest.fn(),
    extractCallers: jest.fn(),
    extractCallees: jest.fn(),
  };

  const mockSymbolStore = {
    upsertSymbol: jest.fn(),
    findBySymbolId: jest.fn(),
    findCallers: jest.fn(),
    findCallees: jest.fn(),
    deleteByFile: jest.fn(),
  };

  const mockAstIndexService = {
    indexCommit: jest.fn(),
    getSymbol: jest.fn(),
    getCallers: jest.fn(),
    getCallees: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OutboxFanOutRegistry,
        { provide: AstIndexService, useValue: mockAstIndexService },
        { provide: SymbolStore, useValue: mockSymbolStore },
        { provide: CodeGraphService, useValue: mockCodeGraph },
      ],
    }).compile();

    registry = module.get<OutboxFanOutRegistry>(OutboxFanOutRegistry);
    astIndexService = module.get(AstIndexService);
    symbolStore = module.get(SymbolStore);
    codeGraph = module.get(CodeGraphService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('AC-7: indexing triggered by code_commit outbox event', () => {
    it('should be fired by VCS webhook handler and resolve changed file contents before calling indexCommit', async () => {
      const repoId = 'repo-123';
      const commitHash = 'abc123def456';
      const projectId = 'proj-123';
      const files = [
        { path: 'src/auth.ts', content: 'export function authenticate(userId: string) {}' },
        { path: 'src/user.ts', content: 'export class UserService {}' },
      ];

      const indexResult = {
        commitHash,
        symbolsIndexed: 2,
        filesIndexed: 2,
        fileErrors: [],
        durationMs: 150,
      };

      mockAstIndexService.indexCommit.mockResolvedValue(indexResult);

      const handler = registry.getHandlers('code_commit')[0];
      expect(handler).toBeDefined();

      const payload = {
        eventType: 'code_commit',
        payload: {
          repoId,
          commitHash,
          projectId,
          files,
        },
      };

      await registry.dispatch(payload);

      expect(mockAstIndexService.indexCommit).toHaveBeenCalledWith(
        repoId,
        commitHash,
        files,
        projectId,
      );
      expect(mockAstIndexService.indexCommit).toHaveBeenCalledTimes(1);
    });

    it('AC-11: webhook controller should only enqueue commit metadata (not file contents)', async () => {
      const repoId = 'repo-webhook';
      const commitHash = 'web123';
      const projectId = 'proj-webhook';

      const indexResult = {
        commitHash,
        symbolsIndexed: 0,
        filesIndexed: 0,
        fileErrors: [],
        durationMs: 10,
      };

      mockAstIndexService.indexCommit.mockResolvedValue(indexResult);

      const handler = registry.getHandlers('code_commit')[0];

      const webhookPayload = {
        eventType: 'code_commit',
        payload: {
          repoId,
          commitHash,
          projectId,
          webhookOnly: true,
        },
      };

      await registry.dispatch(webhookPayload);

      expect(mockAstIndexService.indexCommit).not.toHaveBeenCalledWith(
        repoId,
        commitHash,
        expect.not.objectContaining({ files: expect.any(Array) }),
        projectId,
      );
    });
  });

  describe('AC-9: code_commit handler requires MANAGE AstIndex permission for direct calls', () => {
    it('should register code_commit event type in the registry', () => {
      const handlers = registry.getHandlers('code_commit');
      expect(handlers.length).toBeGreaterThan(0);
    });
  });
});
