import { KbDocumentDeletion } from './kb-document-deletion.service';
import { ApprovalRouteGate } from '../approvals/route/approval-route-gate';
import { ApprovalPending } from '../approvals/route/approval-pending';
import type { Mock, Mocked } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenAppException, NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { RagController } from './rag.controller';
import { AuditRecorder } from '../audit/audit-recorder.service';
import { RagService } from './rag.service';
import { HybridRetrieverService } from './hybrid-retriever.service';
import { PrismaRagRepository } from './prisma-rag.repository';
import { ProjectAccessService } from '../projects/project-access.service';
import { PermissionService } from '../permissions/permission.service';
import type { PermissionDecision } from '../permissions/permissions.types';
import type { AgentPrincipal, UserPrincipal } from '../auth/principal/koda-principal.types';
import type { ListKbDocumentsQuery } from './dto/list-kb-documents.query';

const mockProject = {
  id: 'proj-1',
  slug: 'alpha',
  name: 'Alpha',
  key: 'ALP',
  graphifyEnabled: false,
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const allow: PermissionDecision = { allowed: true, reason: 'granted' };

const devUser: UserPrincipal = {
  actorType: 'user',
  id: 'user-dev',
  name: 'Dev',
  email: 'dev@koda.dev',
  role: 'MEMBER',
  blacklisted: false,
  revoked: false,
  authorities: ['MEMBER'],
};

const agent: AgentPrincipal = {
  actorType: 'agent',
  id: 'agent-1',
  name: 'Bot',
  slug: 'bot',
  status: 'ACTIVE',
  agentRoles: ['DEVELOPER'],
  capabilities: [],
  blacklisted: false,
  revoked: false,
  authorities: ['WORKER'],
};


describe('RagController', () => {
  let controller: RagController;
  let ragService: Mocked<RagService>;
  let hybridRetrieverService: Mocked<HybridRetrieverService>;
  let can: Mock;
  const audit = { audited: vi.fn(async (fn: () => Promise<unknown>, entriesOf: (result: unknown) => unknown) => {
    const result = await fn();
    entriesOf(result);
    return result;
  }), record: vi.fn() };

  const deletion = { preflight: vi.fn() };
  const gate = { run: vi.fn() };
  let module: TestingModule;
  const mockFindProjectBySlug = vi.fn();
  const mockUpdateGraphifyLastImportedAt = vi.fn();

  // US-005: PrismaRagRepository.findProjectMembership was deleted — membership
  // is ProjectMembershipGuard's job, so the controller's repository stub no
  // longer carries a membership lookup.
  const mockRagRepository: Partial<PrismaRagRepository> = {
    findProjectBySlug: mockFindProjectBySlug,
    updateGraphifyLastImportedAt: mockUpdateGraphifyLastImportedAt,
  };

  beforeEach(async () => {
    deletion.preflight.mockReset().mockResolvedValue([]);
    gate.run.mockReset().mockResolvedValue({ status: 'executed', result: { deleted: true } });
    can = vi.fn().mockResolvedValue(allow);

    ragService = {
      indexDocument: vi.fn(),
      listDocuments: vi.fn(),
      deleteBySource: vi.fn(),
      findSourceCreators: vi.fn().mockResolvedValue([]),
      importGraphify: vi.fn(),
      optimizeTable: vi.fn(),
    } as unknown as Mocked<RagService>;

    hybridRetrieverService = {
      indexDocument: vi.fn(),
      search: vi.fn(),
    } as unknown as Mocked<HybridRetrieverService>;

    module = await Test.createTestingModule({
      controllers: [RagController],
      providers: [
        { provide: KbDocumentDeletion, useValue: deletion },
        { provide: ApprovalRouteGate, useValue: gate },
        { provide: RagService, useValue: ragService },
        { provide: HybridRetrieverService, useValue: hybridRetrieverService },
        { provide: PrismaRagRepository, useValue: mockRagRepository },
        // US-001: the `@UseGuards(...)` classes are instantiated by the DI
        // container even though these tests call the handlers directly, so their
        // ProjectAccessService (membership) and PermissionService (keys) dependencies must resolve.
        { provide: ProjectAccessService, useValue: {} },
        { provide: PermissionService, useValue: { can } },
        { provide: AuditRecorder, useValue: audit },
      ],
    }).compile();

    controller = module.get<RagController>(RagController);
  });

  afterEach(async () => {
    await module.close();
    vi.clearAllMocks();
  });

  describe('addDocument', () => {
    it('AC-11: gates in the resolved project with frozen document input', async () => {
      mockFindProjectBySlug.mockResolvedValue(mockProject);
      const dto = { source: 'manual' as const, sourceId: 's1', content: 'hello' };
      await controller.addDocument('alpha', dto, agent);
      expect(gate.run).toHaveBeenCalledWith({ key: 'kb.document.add', variant: 'rest:kb-documents.add', projectId: 'proj-1', input: { slug: 'alpha', projectId: 'proj-1', document: dto } });
    });
    it('maps a pending add to ApprovalPending without writing', async () => {
      mockFindProjectBySlug.mockResolvedValue(mockProject);
      gate.run.mockResolvedValue({ status: 'pending', request: { id: 'approval1' } });
      await expect(controller.addDocument('alpha', { source: 'manual', sourceId: 's1', content: 'hello' }, agent)).rejects.toBeInstanceOf(ApprovalPending);
      expect(ragService.indexDocument).not.toHaveBeenCalled();
    });
    it('throws NotFoundAppException when project not found', async () => {
      mockFindProjectBySlug.mockResolvedValue(null);

      await expect(
        controller.addDocument(
          'missing',
          { source: 'doc', sourceId: 'x', content: 'y', metadata: {} },
          devUser,
        ),
      ).rejects.toThrow(NotFoundAppException);
    });

    it('throws NotFoundAppException when project is soft-deleted', async () => {
      mockFindProjectBySlug.mockResolvedValue({ ...mockProject, deletedAt: new Date() });

      await expect(
        controller.addDocument(
          'alpha',
          { source: 'doc', sourceId: 'x', content: 'y', metadata: {} },
          devUser,
        ),
      ).rejects.toThrow(NotFoundAppException);
    });

    // US-001: the membership gate for this route moved to ProjectMembershipGuard,
    // which runs before the handler. The key gate is RequiresGuard's — covered by
    // the route-level cases in projects/project-membership.guard.routes.spec.ts and
    // the HTTP matrix in test/integration/rag/permissions-kb-routes.integration.spec.ts.
  });

  describe('listDocuments', () => {
    it('lists documents with default limit 100', async () => {
      mockFindProjectBySlug.mockResolvedValue(mockProject);
      ragService.listDocuments.mockResolvedValue([]);

      await controller.listDocuments('alpha', {} as ListKbDocumentsQuery);

      expect(ragService.listDocuments).toHaveBeenCalledWith('proj-1', 100);
    });

    it('uses the validated limit', async () => {
      mockFindProjectBySlug.mockResolvedValue(mockProject);
      ragService.listDocuments.mockResolvedValue([]);

      await controller.listDocuments('alpha', { limit: '25' } as unknown as ListKbDocumentsQuery);

      expect(ragService.listDocuments).toHaveBeenCalledWith('proj-1', 25);
    });

    it('lists documents with no query at all', async () => {
      mockFindProjectBySlug.mockResolvedValue(mockProject);
      ragService.listDocuments.mockResolvedValue([]);

      await controller.listDocuments('alpha');

      expect(ragService.listDocuments).toHaveBeenCalled();
    });

    // US-001: the membership gate for this route moved to ProjectMembershipGuard
    // (see projects/project-membership.guard.routes.spec.ts).
  });

  describe('deleteDocument', () => {
    it('preflights before the gate and wraps the executed result', async () => {
      mockFindProjectBySlug.mockResolvedValue(mockProject);
      gate.run.mockImplementation(async () => {
        expect(deletion.preflight).toHaveBeenCalledWith(devUser, 'proj-1', 's1', 'manual');
        return { status: 'executed', result: { deleted: true } };
      });
      const result = await controller.deleteDocument('alpha', 's1', { source: 'manual' }, devUser);
      expect(gate.run).toHaveBeenCalledWith({ key: 'kb.document.delete', variant: 'rest:kb-documents.delete', projectId: 'proj-1', input: { projectId: 'proj-1', sourceId: 's1', source: 'manual' } });
      expect(result.data).toEqual({ deleted: true });
    });
    it('maps pending to ApprovalPending', async () => {
      mockFindProjectBySlug.mockResolvedValue(mockProject);
      gate.run.mockResolvedValue({ status: 'pending', request: { id: 'request-1' } });
      await expect(controller.deleteDocument('alpha', 's1', {}, devUser)).rejects.toThrow(ApprovalPending);
    });
    it('refuses ownership before the gate', async () => {
      mockFindProjectBySlug.mockResolvedValue(mockProject);
      deletion.preflight.mockRejectedValue(new ForbiddenAppException({}, 'permissions'));
      await expect(controller.deleteDocument('alpha', 's1', {}, devUser)).rejects.toThrow(ForbiddenAppException);
      expect(gate.run).not.toHaveBeenCalled();
    });
    it('resolves missing projects before preflight or gate with rag', async () => {
      mockFindProjectBySlug.mockResolvedValue(null);
      await expect(controller.deleteDocument('missing', 's1', {}, devUser)).rejects.toMatchObject({ response: { prefix: 'rag' } });
      expect(deletion.preflight).not.toHaveBeenCalled();
      expect(gate.run).not.toHaveBeenCalled();
    });
  });

  describe('search', () => {
    const mockSearchResult = {
      results: [],
      scores: [],
      retrievedAt: new Date().toISOString(),
    };

    it('searches with the project graphify flag and the requested limit', async () => {
      mockFindProjectBySlug.mockResolvedValue(mockProject);
      hybridRetrieverService.search.mockResolvedValue(mockSearchResult);

      const result = await controller.search('alpha', { query: 'auth bug', limit: 10 });

      expect(hybridRetrieverService.search).toHaveBeenCalledWith({
        projectId: 'proj-1',
        query: 'auth bug',
        limit: 10,
        graphifyEnabled: false,
      });
      expect((result as any).data).toBeDefined();
    });

    it('uses the default limit when the body omits it', async () => {
      mockFindProjectBySlug.mockResolvedValue(mockProject);
      hybridRetrieverService.search.mockResolvedValue(mockSearchResult);

      await controller.search('alpha', { query: 'test' });

      expect(hybridRetrieverService.search).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }));
    });

    // US-001: the membership gate for this route moved to ProjectMembershipGuard
    // (see projects/project-membership.guard.routes.spec.ts). US-007 moved the key
    // gate to `kb.search` (a Developer and a Viewer both hold it through `*.read`,
    // which is why the KB read routes admit a Viewer while the write routes do not).

    it('returns an empty result set', async () => {
      mockFindProjectBySlug.mockResolvedValue(mockProject);
      hybridRetrieverService.search.mockResolvedValue(mockSearchResult);

      const result = await controller.search('alpha', { query: 'test' });

      expect((result as any).data.results).toEqual([]);
    });

    it('throws NotFoundAppException for missing project', async () => {
      mockFindProjectBySlug.mockResolvedValue(null);

      await expect(
        controller.search('missing', { query: 'test' }),
      ).rejects.toThrow(NotFoundAppException);
    });

    it('includes provenance in response', async () => {
      mockFindProjectBySlug.mockResolvedValue(mockProject);
      hybridRetrieverService.search.mockResolvedValue({
        results: [
          {
            id: 'r1',
            source: 'ticket',
            sourceId: 'ticket-1',
            content: 'bug fix',
            score: 0.9,
            similarity: 'high',
            metadata: {},
            createdAt: new Date().toISOString(),
            provenance: { indexedAt: new Date().toISOString(), sourceProjectId: 'proj-1' },
            rank: 1,
          },
        ],
        scores: [{ vectorScore: 0.9, lexicalScore: 0.8, entityScore: 0, recencyScore: 0.5, finalScore: 0.9 }],
        retrievedAt: new Date().toISOString(),
      });

      const result = await controller.search('alpha', { query: 'bug' });

      expect((result as any).data.provenance.sources).toHaveLength(1);
      expect((result as any).data.provenance.sources[0]).toEqual({ sourceType: 'ticket', sourceId: 'ticket-1' });
    });
  });

  describe('importGraphify', () => {
    it('returns immediately when nodes array is empty', async () => {
      mockFindProjectBySlug.mockResolvedValue({ ...mockProject, graphifyEnabled: true });

      const result = await controller.importGraphify('alpha', { nodes: [], links: [] });

      expect(ragService.importGraphify).not.toHaveBeenCalled();
      expect((result as any).data).toEqual({ imported: 0, cleared: 0 });
    });

    it('throws ValidationAppException when graphify is disabled for project', async () => {
      mockFindProjectBySlug.mockResolvedValue({ ...mockProject, graphifyEnabled: false });

      await expect(
        controller.importGraphify(
          'alpha',
          { nodes: [{ id: 'n1', label: 'Foo' }], links: [] },
        ),
      ).rejects.toThrow();
    });

    it('imports nodes and returns the import result (timestamp updated inside service)', async () => {
      mockFindProjectBySlug.mockResolvedValue({ ...mockProject, graphifyEnabled: true });
      ragService.importGraphify.mockResolvedValue({ imported: 1, cleared: 0 } as any);

      const result = await controller.importGraphify(
        'alpha',
        { nodes: [{ id: 'n1', label: 'Foo' }], links: [] },
      );

      expect(ragService.importGraphify).toHaveBeenCalledWith('proj-1', [{ id: 'n1', label: 'Foo' }], []);
      // graphifyLastImportedAt is now updated inside RagService.importGraphify,
      // not in the controller, so the repository mock is not called here.
      expect(mockUpdateGraphifyLastImportedAt).not.toHaveBeenCalled();
      expect((result as any).data).toEqual({ imported: 1, cleared: 0 });
    });
  });

  describe('optimizeTable', () => {
    it('calls ragService.optimizeTable and returns optimized true', async () => {
      mockFindProjectBySlug.mockResolvedValue(mockProject);
      ragService.optimizeTable.mockResolvedValue(undefined);

      const result = await controller.optimizeTable('alpha');

      expect(ragService.optimizeTable).toHaveBeenCalledWith('proj-1');
      expect((result as any).data).toEqual({ optimized: true });
    });
  });
});
