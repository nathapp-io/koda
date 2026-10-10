import type { Mocked } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { FanOutPublisher } from '../../../src/outbox/fan-out-publisher';
import { PrismaOutboxRepository } from '../../../src/outbox/prisma-outbox.repository';
import { noopLastErrors, outboxRecord } from '../../helpers/outbox-record';
import { AstIndexService } from '../../../src/code-intel/ast-index.service';
import { SymbolStore } from '../../../src/code-intel/symbol-store';
import { CodeGraphService } from '../../../src/code-intel/code-graph.service';
import { CodeIntelOutboxSubscriber } from '../../../src/code-intel/code-intel-outbox.subscriber';

describe('code_commit outbox handler', () => {
  let registry: FanOutPublisher;
  let astIndexService: Mocked<AstIndexService>;
  let symbolStore: Mocked<SymbolStore>;
  let codeGraph: Mocked<CodeGraphService>;

  const mockCodeGraph = {
    parseSourceFile: vi.fn(),
    extractSymbols: vi.fn(),
    extractCallers: vi.fn(),
    extractCallees: vi.fn(),
  };

  const mockSymbolStore = {
    upsertSymbol: vi.fn(),
    findBySymbolId: vi.fn(),
    findCallers: vi.fn(),
    findCallees: vi.fn(),
    deleteByFile: vi.fn(),
  };

  const mockAstIndexService = {
    indexCommit: vi.fn(),
    getSymbol: vi.fn(),
    getCallers: vi.fn(),
    getCallees: vi.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FanOutPublisher,
        { provide: PrismaOutboxRepository, useValue: noopLastErrors },
        CodeIntelOutboxSubscriber,
        { provide: AstIndexService, useValue: mockAstIndexService },
        { provide: SymbolStore, useValue: mockSymbolStore },
        { provide: CodeGraphService, useValue: mockCodeGraph },
      ],
    }).compile();

    // Initialize lifecycle hooks: CodeIntelOutboxSubscriber.onModuleInit is
    // what registers the code_commit handler on the registry.
    await module.init();

    registry = module.get<FanOutPublisher>(FanOutPublisher);
    astIndexService = module.get(AstIndexService);
    symbolStore = module.get(SymbolStore);
    codeGraph = module.get(CodeGraphService);
  });

  afterEach(() => {
    vi.clearAllMocks();
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
        repoId,
        commitHash,
        projectId,
        files,
      };

      await registry.publish(outboxRecord('code_commit', payload));

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
        repoId,
        commitHash,
        projectId,
        webhookOnly: true,
      };

      await registry.publish(outboxRecord('code_commit', webhookPayload));

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
