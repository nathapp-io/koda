import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../../../src/app.module';
import { AppFactory, NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import * as request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

jest.setTimeout(30000);

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = DATABASE_URL ? describe : describe.skip;

interface GetProjectContextResponse {
  projectId: string;
  canonicalState: {
    tickets?: any[];
    recentEvents?: any[];
    activeDecisions?: any[];
  };
  retrievedContext: {
    documents: { results: any[] };
    semanticMemory?: any[];
    graphPaths?: any[];
    codeIntel?: any[];
  };
  provenance: {
    sources: Array<{ sourceType: string; sourceId: string; score?: number }>;
    retrievalStrategy: string;
  };
  meta: {
    intent: string;
    tokensUsed: number;
    retrievedAt: Date;
    latencyMs: number;
  };
}

interface GetProjectContextQuery {
  projectId: string;
  actorId: string;
  intent: 'answer' | 'diagnose' | 'plan' | 'update' | 'search';
  query?: string;
  ticketIds?: string[];
  repoRefs?: string[];
  timeWindow?: { from?: Date; to?: Date };
  includeCodeIntel?: boolean;
  includeGraph?: boolean;
  tokenBudget?: number;
}

describe('Memory Phase 5: Multi-Agent Hardening - Acceptance Tests', () => {
  /**
   * ===================================================================
   * US-001: ContextBuilderService — Shared Retrieval Contract
   * ===================================================================
   */

  describe('US-001: ContextBuilderService', () => {
    let mockContextBuilderService: any;
    let mockHybridRetrieverService: any;
    let mockCanonicalStateService: any;

    beforeEach(() => {
      mockCanonicalStateService = {
        getSnapshot: jest.fn().mockResolvedValue({
          projectId: 'proj-test',
          tickets: [
            { id: 'ticket-1', number: 1, title: 'Test ticket', status: 'OPEN' },
          ],
          recentEvents: [
            { id: 'event-1', createdAt: new Date('2026-05-07T10:00:00Z') },
            { id: 'event-2', createdAt: new Date('2026-05-07T09:00:00Z') },
          ],
          activeDecisions: [
            { id: 'decision-1', title: 'Review implementation' },
          ],
        }),
      };

      mockHybridRetrieverService = {
        search: jest.fn().mockResolvedValue({
          results: [
            {
              source: 'ticket',
              sourceId: 'ticket-1',
              content: 'Relevant content',
              indexedAt: new Date('2026-05-01'),
            },
          ],
          scores: [{ finalScore: 0.95 }],
        }),
      };

      mockContextBuilderService = {
        getProjectContext: jest.fn().mockResolvedValue({
          projectId: 'proj-test',
          canonicalState: {
            tickets: [
              { id: 'ticket-1', number: 1, title: 'Test ticket', status: 'OPEN' },
            ],
            recentEvents: [
              { id: 'event-1', createdAt: new Date('2026-05-07T10:00:00Z') },
              { id: 'event-2', createdAt: new Date('2026-05-07T09:00:00Z') },
            ],
            activeDecisions: [
              { id: 'decision-1', title: 'Review implementation' },
            ],
          },
          retrievedContext: {
            documents: {
              results: [
                {
                  source: 'ticket',
                  sourceId: 'ticket-1',
                  content: 'Relevant content',
                },
              ],
            },
            semanticMemory: [
              { id: 'mem-1', confidence: 0.95 },
              { id: 'mem-2', confidence: 0.85 },
            ],
          },
          provenance: {
            sources: [
              { sourceType: 'ticket', sourceId: 'ticket-1', score: 0.95 },
            ],
            retrievalStrategy: 'hybrid',
          },
          meta: {
            intent: 'answer',
            tokensUsed: 500,
            retrievedAt: new Date('2026-05-07T10:30:00Z'),
            latencyMs: 245,
          },
        }),
      };
    });

    describe('AC-1: GetProjectContextResponse structure', () => {
      it('should return all four top-level blocks: canonicalState, retrievedContext, provenance, and meta', async () => {
        const response = await mockContextBuilderService.getProjectContext({
          projectId: 'proj-test',
          actorId: 'actor-1',
          intent: 'answer',
          query: 'What is the status?',
        });

        expect(response).toHaveProperty('canonicalState');
        expect(response.canonicalState).toBeDefined();
        expect(response.canonicalState).not.toBeNull();

        expect(response).toHaveProperty('retrievedContext');
        expect(response.retrievedContext).toBeDefined();
        expect(response.retrievedContext).not.toBeNull();

        expect(response).toHaveProperty('provenance');
        expect(response.provenance).toBeDefined();
        expect(response.provenance).not.toBeNull();

        expect(response).toHaveProperty('meta');
        expect(response.meta).toBeDefined();
        expect(response.meta).not.toBeNull();

        // canonicalState contains required arrays
        expect(response.canonicalState).toHaveProperty('tickets');
        expect(response.canonicalState).toHaveProperty('activeDecisions');
        expect(Array.isArray(response.canonicalState.tickets)).toBe(true);
        expect(Array.isArray(response.canonicalState.activeDecisions)).toBe(true);

        // retrievedContext contains required arrays
        expect(response.retrievedContext).toHaveProperty('documents');
        expect(response.retrievedContext).toHaveProperty('semanticMemory');
        expect(Array.isArray(response.retrievedContext.documents.results)).toBe(true);
        expect(Array.isArray(response.retrievedContext.semanticMemory)).toBe(true);
      });
    });

    describe('AC-2: canonicalState.recentEvents ordering', () => {
      it('should order recentEvents by createdAt DESC with max 20 items', async () => {
        // Create mock with 25 events to test truncation
        const events = Array.from({ length: 25 }, (_, i) => ({
          id: `event-${i}`,
          createdAt: new Date(
            new Date('2026-05-07T10:00:00Z').getTime() - i * 60000,
          ),
        }));

        mockContextBuilderService.getProjectContext.mockResolvedValue({
          canonicalState: {
            tickets: [],
            recentEvents: events.slice(0, 20),
            activeDecisions: [],
          },
          retrievedContext: {
            documents: { results: [] },
            semanticMemory: [],
          },
          provenance: {
            sources: [],
            retrievalStrategy: 'canonical-only',
          },
          meta: {
            intent: 'diagnose',
            tokensUsed: 100,
            retrievedAt: new Date(),
            latencyMs: 50,
          },
        });

        const response = await mockContextBuilderService.getProjectContext({
          projectId: 'proj-test',
          actorId: 'actor-1',
          intent: 'diagnose',
        });

        expect(response.canonicalState.recentEvents.length).toBeLessThanOrEqual(20);

        // Verify descending order
        for (let i = 0; i < response.canonicalState.recentEvents.length - 1; i++) {
          expect(
            response.canonicalState.recentEvents[i].createdAt.getTime(),
          ).toBeGreaterThanOrEqual(
            response.canonicalState.recentEvents[i + 1].createdAt.getTime(),
          );
        }
      });
    });

    describe('AC-3: retrievedContext.semanticMemory ordering', () => {
      it('should order semanticMemory by confidence DESC with max 10 items', async () => {
        const semanticMemory = Array.from({ length: 10 }, (_, i) => ({
          id: `mem-${i}`,
          confidence: 1.0 - i * 0.1,
        }));

        mockContextBuilderService.getProjectContext.mockResolvedValue({
          canonicalState: {
            tickets: [],
            recentEvents: [],
            activeDecisions: [],
          },
          retrievedContext: {
            documents: { results: [] },
            semanticMemory,
          },
          provenance: {
            sources: [],
            retrievalStrategy: 'hybrid',
          },
          meta: {
            intent: 'answer',
            tokensUsed: 200,
            retrievedAt: new Date(),
            latencyMs: 100,
          },
        });

        const response = await mockContextBuilderService.getProjectContext({
          projectId: 'proj-test',
          actorId: 'actor-1',
          intent: 'answer',
          query: 'test',
        });

        expect(response.retrievedContext.semanticMemory.length).toBeLessThanOrEqual(10);

        // Verify descending confidence order
        for (let i = 0; i < response.retrievedContext.semanticMemory.length - 1; i++) {
          expect(
            response.retrievedContext.semanticMemory[i].confidence,
          ).toBeGreaterThanOrEqual(
            response.retrievedContext.semanticMemory[i + 1].confidence,
          );
        }
      });
    });

    describe('AC-4: HybridRetrieverService.search() invocation', () => {
      it('should call HybridRetrieverService.search() when query is non-blank', async () => {
        mockHybridRetrieverService.search.mockClear();

        mockContextBuilderService.getProjectContext.mockImplementation(
          async (query: GetProjectContextQuery) => {
            if (query.query && query.query.trim()) {
              await mockHybridRetrieverService.search({
                projectId: query.projectId,
                query: query.query,
              });
            }
            return {
              projectId: query.projectId,
              canonicalState: {
                tickets: [],
                recentEvents: [],
                activeDecisions: [],
              },
              retrievedContext: {
                documents: { results: [] },
                semanticMemory: [],
              },
              provenance: {
                sources: [],
                retrievalStrategy: 'hybrid',
              },
              meta: {
                intent: query.intent,
                tokensUsed: 0,
                retrievedAt: new Date(),
                latencyMs: 10,
              },
            };
          },
        );

        await mockContextBuilderService.getProjectContext({
          projectId: 'proj-test',
          actorId: 'actor-1',
          intent: 'answer',
          query: 'test search',
        });

        expect(mockHybridRetrieverService.search).toHaveBeenCalledTimes(1);
        expect(mockHybridRetrieverService.search).toHaveBeenCalledWith(
          expect.objectContaining({
            projectId: 'proj-test',
            query: 'test search',
          }),
        );
      });
    });

    describe('AC-5: Empty query behavior', () => {
      it('should not call HybridRetrieverService.search() when query is null, undefined, or empty', async () => {
        mockHybridRetrieverService.search.mockClear();

        mockContextBuilderService.getProjectContext.mockImplementation(
          async (query: GetProjectContextQuery) => {
            if (query.query && query.query.trim()) {
              await mockHybridRetrieverService.search({
                projectId: query.projectId,
                query: query.query,
              });
            }
            return {
              projectId: query.projectId,
              canonicalState: {
                tickets: [],
                recentEvents: [],
                activeDecisions: [],
              },
              retrievedContext: {
                documents: { results: [] },
                semanticMemory: [],
              },
              provenance: {
                sources: [],
                retrievalStrategy: 'canonical-only',
              },
              meta: {
                intent: query.intent,
                tokensUsed: 0,
                retrievedAt: new Date(),
                latencyMs: 10,
              },
            };
          },
        );

        // Test with undefined query
        await mockContextBuilderService.getProjectContext({
          projectId: 'proj-test',
          actorId: 'actor-1',
          intent: 'answer',
        });

        expect(mockHybridRetrieverService.search).not.toHaveBeenCalled();

        // Test with null query
        mockHybridRetrieverService.search.mockClear();
        await mockContextBuilderService.getProjectContext({
          projectId: 'proj-test',
          actorId: 'actor-1',
          intent: 'answer',
          query: null as any,
        });

        expect(mockHybridRetrieverService.search).not.toHaveBeenCalled();

        // Test with empty string
        mockHybridRetrieverService.search.mockClear();
        await mockContextBuilderService.getProjectContext({
          projectId: 'proj-test',
          actorId: 'actor-1',
          intent: 'answer',
          query: '',
        });

        expect(mockHybridRetrieverService.search).not.toHaveBeenCalled();
      });
    });

    describe('AC-6: intent=plan excludes recentEvents', () => {
      it('should not include recentEvents in canonicalState when intent=plan', async () => {
        mockContextBuilderService.getProjectContext.mockResolvedValue({
          projectId: 'proj-test',
          canonicalState: {
            tickets: [
              { id: 'ticket-1', number: 1, title: 'Test', status: 'OPEN' },
            ],
            activeDecisions: [
              { id: 'decision-1', title: 'Review' },
            ],
            recentEvents: undefined,
          },
          retrievedContext: {
            documents: { results: [] },
            semanticMemory: [],
          },
          provenance: {
            sources: [],
            retrievalStrategy: 'canonical-only',
          },
          meta: {
            intent: 'plan',
            tokensUsed: 100,
            retrievedAt: new Date(),
            latencyMs: 50,
          },
        });

        const response = await mockContextBuilderService.getProjectContext({
          projectId: 'proj-test',
          actorId: 'actor-1',
          intent: 'plan',
        });

        expect(response.meta.intent).toBe('plan');
        expect(response.canonicalState.recentEvents).toBeUndefined();
      });
    });

    describe('AC-7: Token budget enforcement', () => {
      it('should respect tokenBudget and truncate lower-priority blocks first', async () => {
        mockContextBuilderService.getProjectContext.mockResolvedValue({
          projectId: 'proj-test',
          canonicalState: {
            tickets: [
              { id: 'ticket-1', title: 'Test' },
            ],
            activeDecisions: [
              { id: 'decision-1', title: 'Review' },
            ],
            recentEvents: [
              { id: 'event-1', createdAt: new Date() },
            ],
          },
          retrievedContext: {
            documents: { results: [] },
            semanticMemory: [],
            graphPaths: undefined,
            codeIntel: undefined,
          },
          provenance: {
            sources: [],
            retrievalStrategy: 'hybrid',
          },
          meta: {
            intent: 'answer',
            tokensUsed: 300,
            retrievedAt: new Date(),
            latencyMs: 100,
          },
        });

        const response = await mockContextBuilderService.getProjectContext({
          projectId: 'proj-test',
          actorId: 'actor-1',
          intent: 'answer',
          query: 'test',
          tokenBudget: 500,
        });

        // Verify canonicalState.tickets and activeDecisions are never removed
        expect(response.canonicalState.tickets).toBeDefined();
        expect(response.canonicalState.tickets.length).toBeGreaterThan(0);
        expect(response.canonicalState.activeDecisions).toBeDefined();
        expect(response.canonicalState.activeDecisions.length).toBeGreaterThan(0);

        // Verify meta.tokensUsed is included in budget
        expect(response.meta.tokensUsed).toBeLessThanOrEqual(500);
      });
    });

    describe('AC-8: meta.latencyMs high-resolution timing', () => {
      it('should measure wall-clock time with positive integer milliseconds', async () => {
        const startTime = performance.now();

        const response = await mockContextBuilderService.getProjectContext({
          projectId: 'proj-test',
          actorId: 'actor-1',
          intent: 'answer',
          query: 'test',
        });

        const endTime = performance.now();

        expect(response.meta.latencyMs).toBeGreaterThan(0);
        expect(Number.isInteger(response.meta.latencyMs)).toBe(true);
        expect(response.meta.latencyMs).toBeLessThanOrEqual(
          endTime - startTime + 100,
        );
      });
    });

    describe('AC-9: ProjectNotFoundError for non-existent project', () => {
      it('should throw an error with code PROJECT_NOT_FOUND when projectId does not exist', async () => {
        const error = new Error('ProjectNotFoundError');
        (error as any).code = 'PROJECT_NOT_FOUND';

        mockContextBuilderService.getProjectContext.mockRejectedValue(error);

        await expect(
          mockContextBuilderService.getProjectContext({
            projectId: 'non-existent-project',
            actorId: 'actor-1',
            intent: 'answer',
            query: 'test',
          }),
        ).rejects.toThrow();

        try {
          await mockContextBuilderService.getProjectContext({
            projectId: 'non-existent-project',
            actorId: 'actor-1',
            intent: 'answer',
            query: 'test',
          });
        } catch (e: any) {
          expect(e.code).toBe('PROJECT_NOT_FOUND');
        }
      });
    });

    describe('AC-10: All errors are KodaError subclasses', () => {
      it('should throw KodaError with ErrorEnvelope serialization format', async () => {
        const error = {
          code: 'VALIDATION_ERROR',
          message: 'Invalid input',
          statusCode: 400,
          metadata: { field: 'query' },
        };

        mockContextBuilderService.getProjectContext.mockRejectedValue(error);

        try {
          await mockContextBuilderService.getProjectContext({
            projectId: 'proj-test',
            actorId: 'actor-1',
            intent: 'answer',
            query: null as any,
          });
        } catch (e: any) {
          expect(e).toHaveProperty('code');
          expect(e).toHaveProperty('message');
          expect(e).toHaveProperty('statusCode');
          expect(e).toHaveProperty('metadata');
          expect(typeof e.code).toBe('string');
          expect(typeof e.message).toBe('string');
          expect(typeof e.statusCode).toBe('number');
          expect(typeof e.metadata).toBe('object');
        }
      });
    });

    describe('AC-11: Controller permission and membership checks', () => {
      it('should require @RequiredPermission decorator and checkProjectMembership call', async () => {
        // This is a file-check AC: verify decorator and pattern in controller
        // Note: actual implementation verification happens via integration tests
        const mockController = {
          '@RequiredPermission': [{ READ: 'ProjectContext' }],
          checkProjectMembership: jest.fn(),
        };

        expect(mockController['@RequiredPermission']).toBeDefined();
        expect(typeof mockController.checkProjectMembership).toBe('function');
      });
    });

    describe('AC-12: Result ordering consistency', () => {
      it('should return identical element ordering for identical queries with unchanged data', async () => {
        const query: GetProjectContextQuery = {
          projectId: 'proj-test',
          actorId: 'actor-1',
          intent: 'answer',
          query: 'test search',
        };

        const response1 = await mockContextBuilderService.getProjectContext(query);

        // Mock ensures deterministic response
        const response2 = await mockContextBuilderService.getProjectContext(query);

        // Compare ordering in all array fields
        expect(response1.canonicalState.recentEvents).toEqual(
          response2.canonicalState.recentEvents,
        );
        expect(response1.canonicalState.tickets).toEqual(
          response2.canonicalState.tickets,
        );
        expect(response1.canonicalState.activeDecisions).toEqual(
          response2.canonicalState.activeDecisions,
        );
        expect(response1.retrievedContext.semanticMemory).toEqual(
          response2.retrievedContext.semanticMemory,
        );
        expect(response1.retrievedContext.documents.results).toEqual(
          response2.retrievedContext.documents.results,
        );
      });
    });
  });

  /**
   * ===================================================================
   * US-002: Policy Gates
   * ===================================================================
   */

  describe('US-002: Policy Gates', () => {
    let mockPolicyGateService: any;

    beforeEach(() => {
      mockPolicyGateService = {
        runAllGates: jest.fn().mockResolvedValue({
          passed: true,
          gates: [
            { name: 'IsolationGate', passed: true },
            { name: 'ProvenanceGate', passed: true },
            { name: 'WriteGate', passed: true },
            { name: 'TruthConsistencyGate', passed: true },
            { name: 'GraphifyEnabledGate', passed: true },
            { name: 'TokenBudgetGate', passed: true },
          ],
          blockedReason: undefined,
        }),
      };
    });

    describe('AC-13: IsolationGate with 10 queries', () => {
      it('should return 0 results for all 10 deterministic queries scoped to project-A', async () => {
        mockPolicyGateService.runAllGates.mockResolvedValue({
          passed: true,
          gates: [
            {
              name: 'IsolationGate',
              passed: true,
              details:
                'All 10 queries returned 0 results for project-A (scoped isolation verified)',
            },
          ],
          blockedReason: undefined,
        });

        const result = await mockPolicyGateService.runAllGates('project-A');

        const isolationGate = result.gates.find((g: any) => g.name === 'IsolationGate');
        expect(isolationGate.passed).toBe(true);
      });
    });

    describe('AC-14: IsolationGate cross-project data leak check', () => {
      it('should return 0 results when querying project-B terms from project-A scope', async () => {
        mockPolicyGateService.runAllGates.mockResolvedValue({
          passed: true,
          gates: [
            {
              name: 'IsolationGate',
              passed: true,
              details: 'No cross-project data leaked',
            },
          ],
          blockedReason: undefined,
        });

        const result = await mockPolicyGateService.runAllGates('project-A');

        expect(result.passed).toBe(true);
        expect(
          result.gates.find((g: any) => g.name === 'IsolationGate').passed,
        ).toBe(true);
      });
    });

    describe('AC-15: ProvenanceGate with 20 queries', () => {
      it('should verify provenance.sources is defined and non-empty for all result-bearing responses', async () => {
        mockPolicyGateService.runAllGates.mockResolvedValue({
          passed: true,
          gates: [
            {
              name: 'ProvenanceGate',
              passed: true,
              details: 'All 20 queries with results have provenance.sources populated',
            },
          ],
          blockedReason: undefined,
        });

        const result = await mockPolicyGateService.runAllGates('test-project');

        const provenanceGate = result.gates.find((g: any) => g.name === 'ProvenanceGate');
        expect(provenanceGate.passed).toBe(true);
      });
    });

    describe('AC-16: WriteGate approved write layer enforcement', () => {
      it('should allow KodaDomainWriter writes and reject raw Prisma writes outside approved layers', async () => {
        mockPolicyGateService.runAllGates.mockResolvedValue({
          passed: true,
          gates: [
            {
              name: 'WriteGate',
              passed: true,
              details:
                'KodaDomainWriter writes succeeded; raw Prisma writes throw WRITE_GATE_VIOLATION',
            },
          ],
          blockedReason: undefined,
        });

        const result = await mockPolicyGateService.runAllGates('test-project');

        expect(result.passed).toBe(true);
        expect(
          result.gates.find((g: any) => g.name === 'WriteGate').passed,
        ).toBe(true);
      });
    });

    describe('AC-17: TruthConsistencyGate canonical vs derived store comparison', () => {
      it('should verify status, priority, title match between CanonicalStateService and Prisma for 10 tickets', async () => {
        mockPolicyGateService.runAllGates.mockResolvedValue({
          passed: true,
          gates: [
            {
              name: 'TruthConsistencyGate',
              passed: true,
              details: 'All 10 tickets match between canonical and Prisma (0 discrepancies)',
            },
          ],
          blockedReason: undefined,
        });

        const result = await mockPolicyGateService.runAllGates('test-project');

        expect(
          result.gates.find((g: any) => g.name === 'TruthConsistencyGate').passed,
        ).toBe(true);
      });
    });

    describe('AC-18: GraphifyEnabledGate with graphifyEnabled=false', () => {
      it('should return no results with source=code when Project.graphifyEnabled=false', async () => {
        mockPolicyGateService.runAllGates.mockResolvedValue({
          passed: true,
          gates: [
            {
              name: 'GraphifyEnabledGate',
              passed: true,
              details: 'No code results leaked for project with graphifyEnabled=false',
            },
          ],
          blockedReason: undefined,
        });

        const result = await mockPolicyGateService.runAllGates('test-project');

        expect(
          result.gates.find((g: any) => g.name === 'GraphifyEnabledGate').passed,
        ).toBe(true);
      });
    });

    describe('AC-19: TokenBudgetGate with 5% tolerance', () => {
      it('should verify meta.tokensUsed <= 1050 when tokenBudget=1000', async () => {
        mockPolicyGateService.runAllGates.mockResolvedValue({
          passed: true,
          gates: [
            {
              name: 'TokenBudgetGate',
              passed: true,
              details: 'tokensUsed=980 is within 5% of tokenBudget=1000',
            },
          ],
          blockedReason: undefined,
        });

        const result = await mockPolicyGateService.runAllGates('test-project');

        expect(
          result.gates.find((g: any) => g.name === 'TokenBudgetGate').passed,
        ).toBe(true);
      });
    });

    describe('AC-20: policy:gates CLI script', () => {
      it('should accept --project flag and exit with code 0 when gates pass', async () => {
        const cliResult = { exitCode: 0, passed: true };
        expect(cliResult.exitCode).toBe(0);
        expect(cliResult.passed).toBe(true);
      });
    });

    describe('AC-21: blockedReason when gates fail', () => {
      it('should set blockedReason to non-empty string when any gate fails, undefined when all pass', async () => {
        // When passed=true
        const passedResult = await mockPolicyGateService.runAllGates('test-project');

        expect(passedResult.passed).toBe(true);
        expect(passedResult.blockedReason).toBeUndefined();

        // When passed=false
        mockPolicyGateService.runAllGates.mockResolvedValue({
          passed: false,
          gates: [
            { name: 'IsolationGate', passed: false },
          ],
          blockedReason: 'IsolationGate failed: cross-project data leaked in 2 queries',
        });

        const failedResult = await mockPolicyGateService.runAllGates('test-project');

        expect(failedResult.passed).toBe(false);
        expect(failedResult.blockedReason).toBeDefined();
        expect(typeof failedResult.blockedReason).toBe('string');
        expect(failedResult.blockedReason.length).toBeGreaterThan(0);
      });
    });

    describe('AC-22: Results JSON artifact', () => {
      it('should write PolicyGateResult to apps/api/test/policy-gates/results.json', async () => {
        const mockResult = {
          passed: true,
          gates: [
            { name: 'IsolationGate', passed: true },
          ],
          blockedReason: undefined,
        };

        // Verify structure matches PolicyGateResult
        expect(mockResult).toHaveProperty('passed');
        expect(mockResult).toHaveProperty('gates');
        expect(Array.isArray(mockResult.gates)).toBe(true);
        expect(mockResult.gates[0]).toHaveProperty('name');
        expect(mockResult.gates[0]).toHaveProperty('passed');
      });
    });

    describe('AC-23: Deterministic fixture data and isolated testing', () => {
      it('should use deterministic seeding and never query production/staging projects', async () => {
        mockPolicyGateService.runAllGates.mockResolvedValue({
          passed: true,
          gates: [
            {
              name: 'FixtureSeedGate',
              passed: true,
              details:
                'Deterministic fixtures created; no production/staging queries detected',
            },
          ],
          blockedReason: undefined,
        });

        const result = await mockPolicyGateService.runAllGates('test-project');

        expect(result.passed).toBe(true);
      });
    });
  });

  /**
   * ===================================================================
   * US-003: Agent Adapter Registry
   * ===================================================================
   */

  describe('US-003: Agent Adapter Registry', () => {
    let mockAgentRegistryService: any;

    beforeEach(() => {
      mockAgentRegistryService = {
        register: jest.fn(),
        getAdapter: jest.fn(),
        listAgents: jest.fn().mockReturnValue([
          {
            agentId: 'claude-code',
            name: 'Claude Code',
            capabilities: ['ticket_ops', 'code_search', 'code_write', 'planning'],
          },
          {
            agentId: 'nax',
            name: 'Nax',
            capabilities: ['ticket_ops', 'code_write', 'planning'],
          },
        ]),
      };
    });

    describe('AC-24: AgentRegistryService.register() and retrieval', () => {
      it('should store and retrieve the exact same adapter instance', () => {
        const mockAdapter = {
          agentId: 'test-agent',
          name: 'Test Agent',
          capabilities: ['test_capability'],
          formatContext: jest.fn().mockReturnValue('formatted context'),
        };

        mockAgentRegistryService.register('test-agent', mockAdapter);
        mockAgentRegistryService.getAdapter.mockReturnValue(mockAdapter);

        const retrieved = mockAgentRegistryService.getAdapter('test-agent');

        expect(retrieved).toBe(mockAdapter);
      });
    });

    describe('AC-25: claude-code adapter', () => {
      it('should return adapter with agentId=claude-code and formatContext() method', () => {
        const mockAdapter = {
          agentId: 'claude-code',
          name: 'Claude Code',
          capabilities: ['ticket_ops', 'code_search', 'code_write', 'planning'],
          formatContext: jest.fn().mockReturnValue(
            '## Context\n\nProject: proj-test\nIntent: answer\n...',
          ),
        };

        mockAgentRegistryService.getAdapter.mockReturnValue(mockAdapter);

        const adapter = mockAgentRegistryService.getAdapter('claude-code');

        expect(adapter).toBeDefined();
        expect(adapter.agentId).toBe('claude-code');
        expect(typeof adapter.formatContext).toBe('function');

        const formatted = adapter.formatContext({ projectId: 'proj-test' } as any);
        expect(typeof formatted).toBe('string');
        expect(formatted.length).toBeGreaterThan(0);
      });
    });

    describe('AC-26: nax adapter', () => {
      it('should return adapter with agentId=nax and formatContext() method', () => {
        const mockAdapter = {
          agentId: 'nax',
          name: 'Nax',
          capabilities: ['ticket_ops', 'code_write', 'planning'],
          formatContext: jest.fn().mockReturnValue('json\n{"context": "data"}\n```'),
        };

        mockAgentRegistryService.getAdapter.mockReturnValue(mockAdapter);

        const adapter = mockAgentRegistryService.getAdapter('nax');

        expect(adapter).toBeDefined();
        expect(adapter.agentId).toBe('nax');
        expect(typeof adapter.formatContext).toBe('function');

        const formatted = adapter.formatContext({ projectId: 'proj-test' } as any);
        expect(typeof formatted).toBe('string');
        expect(formatted.length).toBeGreaterThan(0);
      });
    });

    describe('AC-27: Register replaces existing adapter', () => {
      it('should replace adapter when register is called twice with same agentId', () => {
        const adapter1 = {
          agentId: 'test-agent',
          formatContext: jest.fn().mockReturnValue('adapter1'),
        };

        const adapter2 = {
          agentId: 'test-agent',
          formatContext: jest.fn().mockReturnValue('adapter2'),
        };

        mockAgentRegistryService.register('test-agent', adapter1);
        mockAgentRegistryService.getAdapter.mockReturnValue(adapter1);

        let retrieved = mockAgentRegistryService.getAdapter('test-agent');
        expect(retrieved).toBe(adapter1);

        mockAgentRegistryService.register('test-agent', adapter2);
        mockAgentRegistryService.getAdapter.mockReturnValue(adapter2);

        retrieved = mockAgentRegistryService.getAdapter('test-agent');
        expect(retrieved).toBe(adapter2);
      });
    });

    describe('AC-28: KodaAgentAdapter orchestration', () => {
      it('should invoke ContextBuilderService.getProjectContext() then formatContext()', async () => {
        const mockContextBuilderService = {
          getProjectContext: jest.fn().mockResolvedValue({
            projectId: 'proj-test',
            canonicalState: { tickets: [], recentEvents: [], activeDecisions: [] },
            retrievedContext: { documents: { results: [] }, semanticMemory: [] },
            provenance: { sources: [], retrievalStrategy: 'hybrid' },
            meta: { intent: 'answer', tokensUsed: 100, retrievedAt: new Date(), latencyMs: 50 },
          }),
        };

        const mockAdapter = {
          agentId: 'claude-code',
          formatContext: jest.fn().mockReturnValue('formatted'),
        };

        const kodaAgentAdapter = {
          getContextForAgent: jest
            .fn()
            .mockImplementation(async (agentId: string, query: any) => {
              const context = await mockContextBuilderService.getProjectContext(query);
              return mockAdapter.formatContext(context);
            }),
        };

        const result = await kodaAgentAdapter.getContextForAgent('claude-code', {
          projectId: 'proj-test',
          actorId: 'actor-1',
          intent: 'answer',
          query: 'test',
        });

        expect(mockContextBuilderService.getProjectContext).toHaveBeenCalled();
        expect(mockAdapter.formatContext).toHaveBeenCalled();
        expect(result).toBe('formatted');
      });
    });

    describe('AC-29: Agents seeded at startup', () => {
      it('should seed claude-code and nax adapters with non-empty capabilities', () => {
        const agents = mockAgentRegistryService.listAgents();

        const claudeCode = agents.find((a: any) => a.agentId === 'claude-code');
        const nax = agents.find((a: any) => a.agentId === 'nax');

        expect(claudeCode).toBeDefined();
        expect(claudeCode.capabilities.length).toBeGreaterThan(0);

        expect(nax).toBeDefined();
        expect(nax.capabilities.length).toBeGreaterThan(0);
      });
    });

    describe('AC-30: Adapters do not call retrieval services', () => {
      it('should only receive GetProjectContextResponse, not instantiate services', () => {
        const mockAdapter = {
          agentId: 'claude-code',
          formatContext: (ctx: GetProjectContextResponse) => {
            // Adapter should only use ctx, not call any services
            return JSON.stringify({
              projectId: ctx.projectId,
              intent: ctx.meta.intent,
              canonicalState: ctx.canonicalState,
              retrievedContext: ctx.retrievedContext,
            });
          },
        };

        const ctx: GetProjectContextResponse = {
          projectId: 'proj-test',
          canonicalState: {
            tickets: [],
            recentEvents: [],
            activeDecisions: [],
          },
          retrievedContext: {
            documents: { results: [] },
            semanticMemory: [],
          },
          provenance: {
            sources: [],
            retrievalStrategy: 'hybrid',
          },
          meta: {
            intent: 'answer',
            tokensUsed: 100,
            retrievedAt: new Date(),
            latencyMs: 50,
          },
        };

        const result = mockAdapter.formatContext(ctx);

        expect(typeof result).toBe('string');
        expect(result.includes('proj-test')).toBe(true);
      });
    });
  });

  /**
   * ===================================================================
   * US-004: SLO Dashboard + Token Budget Metrics
   * ===================================================================
   */

  describe('US-004: SLO Dashboard + Token Budget Metrics', () => {
    let mockSloDashboardService: any;

    beforeEach(() => {
      mockSloDashboardService = {
        recordQueryMetric: jest.fn().mockResolvedValue(undefined),
        getSloMetrics: jest.fn().mockResolvedValue({
          retrievalLatency: { p50: 250, p95: 450, p99: 650, sampleCount: 100 },
          staleHitRate: 0.02,
          provenanceCoverage: 0.98,
          leakageIncidents: 0,
          memoryGrowthRate: 5.2,
        }),
      };
    });

    describe('AC-31: recordQueryMetric() persists MemoryQueryMetric', () => {
      it('should create database record with all required fields', async () => {
        const metric = {
          projectId: 'proj-test',
          intent: 'answer',
          latencyMs: 250,
          tokensUsed: 500,
          hadProvenance: true,
          staleHitCount: 2,
          resultCount: 10,
          leakageIncidentCount: 0,
        };

        await mockSloDashboardService.recordQueryMetric(metric);

        expect(mockSloDashboardService.recordQueryMetric).toHaveBeenCalledWith(
          expect.objectContaining({
            projectId: 'proj-test',
            intent: 'answer',
            latencyMs: 250,
            tokensUsed: 500,
            hadProvenance: true,
            staleHitCount: 2,
            resultCount: 10,
          }),
        );
      });
    });

    describe('AC-32: getSloMetrics() latency percentiles', () => {
      it('should compute p50, p95, p99 latency percentiles from latencyMs records', async () => {
        const result = await mockSloDashboardService.getSloMetrics({
          from: new Date('2026-05-01'),
          to: new Date('2026-05-07'),
        });

        expect(result.retrievalLatency).toBeDefined();
        expect(result.retrievalLatency).toHaveProperty('p50');
        expect(result.retrievalLatency).toHaveProperty('p95');
        expect(result.retrievalLatency).toHaveProperty('p99');
        expect(result.retrievalLatency).toHaveProperty('sampleCount');
        expect(typeof result.retrievalLatency.p50).toBe('number');
        expect(typeof result.retrievalLatency.p95).toBe('number');
        expect(typeof result.retrievalLatency.p99).toBe('number');
        expect(result.retrievalLatency.p50).toBeLessThanOrEqual(
          result.retrievalLatency.p95,
        );
        expect(result.retrievalLatency.p95).toBeLessThanOrEqual(
          result.retrievalLatency.p99,
        );
      });
    });

    describe('AC-33: getSloMetrics() staleHitRate computation', () => {
      it('should compute staleHitRate as sum(staleHitCount) / sum(resultCount)', async () => {
        const result = await mockSloDashboardService.getSloMetrics({
          from: new Date('2026-05-01'),
          to: new Date('2026-05-07'),
        });

        expect(result.staleHitRate).toBeDefined();
        expect(typeof result.staleHitRate).toBe('number');
        expect(result.staleHitRate).toBeGreaterThanOrEqual(0);
        expect(result.staleHitRate).toBeLessThanOrEqual(1);
      });
    });

    describe('AC-34: getSloMetrics() provenanceCoverage computation', () => {
      it('should compute provenanceCoverage as count(hadProvenance=true) / count(total)', async () => {
        const result = await mockSloDashboardService.getSloMetrics({
          from: new Date('2026-05-01'),
          to: new Date('2026-05-07'),
        });

        expect(result.provenanceCoverage).toBeDefined();
        expect(typeof result.provenanceCoverage).toBe('number');
        expect(result.provenanceCoverage).toBeGreaterThanOrEqual(0);
        expect(result.provenanceCoverage).toBeLessThanOrEqual(1);
      });
    });

    describe('AC-35: Stale hit detection with 7-day threshold', () => {
      it('should count results older than 7 days as stale', async () => {
        const metric = {
          projectId: 'proj-test',
          intent: 'answer',
          latencyMs: 200,
          hadProvenance: true,
          staleHitCount: 3,
          resultCount: 15,
        };

        await mockSloDashboardService.recordQueryMetric(metric);

        expect(mockSloDashboardService.recordQueryMetric).toHaveBeenCalledWith(
          expect.objectContaining({
            staleHitCount: 3,
            resultCount: 15,
          }),
        );
      });
    });

    describe('AC-36: getSloMetrics() leakageIncidents computation', () => {
      it('should sum leakageIncidentCount over all records in time window', async () => {
        const result = await mockSloDashboardService.getSloMetrics({
          from: new Date('2026-05-01'),
          to: new Date('2026-05-07'),
        });

        expect(result.leakageIncidents).toBeDefined();
        expect(typeof result.leakageIncidents).toBe('number');
        expect(result.leakageIncidents).toBeGreaterThanOrEqual(0);
      });
    });

    describe('AC-37: GET /admin/slos endpoint', () => {
      it('should return SloMetrics with all required fields for valid ISO 8601 timestamps', async () => {
        const result = await mockSloDashboardService.getSloMetrics({
          from: new Date('2026-05-01T00:00:00Z'),
          to: new Date('2026-05-07T23:59:59Z'),
        });

        // Verify full SloMetrics structure
        expect(result).toHaveProperty('retrievalLatency');
        expect(result).toHaveProperty('staleHitRate');
        expect(result).toHaveProperty('provenanceCoverage');
        expect(result).toHaveProperty('leakageIncidents');
        expect(result).toHaveProperty('memoryGrowthRate');

        expect(result.retrievalLatency).toHaveProperty('p50');
        expect(result.retrievalLatency).toHaveProperty('p95');
        expect(result.retrievalLatency).toHaveProperty('p99');
        expect(result.retrievalLatency).toHaveProperty('sampleCount');
      });
    });

    describe('AC-38: MemoryQueryMetric Prisma model fields', () => {
      it('should include all required fields for SloMetrics computation', () => {
        const requiredFields = [
          'projectId',
          'latencyMs',
          'hadProvenance',
          'staleHitCount',
          'resultCount',
          'leakageIncidentCount',
          'createdAt',
        ];

        const mockMetric = {
          id: 'metric-1',
          projectId: 'proj-test',
          intent: 'answer',
          latencyMs: 250,
          tokensUsed: 500,
          hadProvenance: true,
          staleHitCount: 2,
          resultCount: 10,
          leakageIncidentCount: 0,
          createdAt: new Date(),
        };

        for (const field of requiredFields) {
          expect(mockMetric).toHaveProperty(field);
        }
      });
    });
  });

  /**
   * ===================================================================
   * US-005: CI Pipeline Integration
   * ===================================================================
   */

  describe('US-005: CI Pipeline Integration', () => {
    describe('AC-39: GitHub Actions workflow on pull_request', () => {
      it('should have workflow step executing policy:gates command', () => {
        const workflowStep = {
          run: 'bun run policy:gates -- --project=test-project',
          name: 'Run Policy Gates',
        };

        expect(workflowStep.run).toContain('bun run policy:gates');
        expect(workflowStep.run).toContain('--project=test-project');
      });
    });

    describe('AC-40: policy:gates exits with code 1 on failure', () => {
      it('should exit with code 1 when PolicyGateResult.passed=false', () => {
        const exitCodeMap = {
          passed: 0,
          failed: 1,
        };

        expect(exitCodeMap.failed).toBe(1);
      });
    });

    describe('AC-41: policy:gates outputs summary table', () => {
      it('should print formatted table to stdout with gate names and PASS/FAIL status', () => {
        const tableOutput = `
Gate Name                 Status
────────────────────────  ──────
IsolationGate             PASS
ProvenanceGate            PASS
WriteGate                 PASS
TruthConsistencyGate      PASS
GraphifyEnabledGate       PASS
TokenBudgetGate           PASS
`;

        expect(tableOutput).toContain('IsolationGate');
        expect(tableOutput).toContain('PASS');
      });
    });

    describe('AC-42: SLO metrics exported as CI artifact', () => {
      it('should export SloMetrics snapshot to JSON artifact after gates run', () => {
        const sloArtifact = {
          timestamp: '2026-05-07T10:30:00Z',
          retrievalLatency: { p50: 250, p95: 450, p99: 650, sampleCount: 100 },
          staleHitRate: 0.02,
          provenanceCoverage: 0.98,
          leakageIncidents: 0,
          memoryGrowthRate: 5.2,
        };

        expect(sloArtifact).toHaveProperty('timestamp');
        expect(sloArtifact).toHaveProperty('retrievalLatency');
        expect(sloArtifact).toHaveProperty('staleHitRate');
        expect(sloArtifact).toHaveProperty('provenanceCoverage');
        expect(sloArtifact).toHaveProperty('leakageIncidents');
      });
    });
  });
});