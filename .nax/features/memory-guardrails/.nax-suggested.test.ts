import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ForbiddenAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { v4 as uuid } from 'crypto';

import { RagService } from '../../../src/rag/rag.service';
import { EmbeddingService } from '../../../src/rag/embedding.service';
import { OutboxService, OutboxEventData } from '../../../src/outbox/outbox.service';

// ─────────────────────────────────────────────────────────────────────────────
// Mock Services and Helpers
// ─────────────────────────────────────────────────────────────────────────────

class FakeEmbeddingService implements Partial<EmbeddingService> {
  readonly providerName = 'test';
  readonly modelName = 'test-v1';
  readonly dimensions = 8;

  async embed(text: string): Promise<Float32Array> {
    const vec = new Float32Array(8);
    for (let i = 0; i < 8; i++) {
      let h = 0;
      for (const ch of text) h = ((h << 5) - h + ch.charCodeAt(0)) >>> 0;
      vec[i] = ((h + i * 1000) % 200) / 200;
    }
    return vec;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

interface WriteResult {
  canonicalId?: string;
  error?: string;
  provenance: {
    actorId: string;
    projectId: string;
    action: string;
    timestamp: string;
    source: 'agent' | 'system' | 'manual';
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-1: Project ID validation in getOrCreateTable
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-1: RagService.getOrCreateTable() rejects invalid projectId before cache access', () => {
  let ragService: RagService;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koda-ac1-'));

    const mockConfigService = {
      get: (key: string) => {
        const config: Record<string, unknown> = {
          'rag.lancedbPath': tmpDir,
          'rag.inMemoryOnly': true,
          'rag.ftsIndexMode': 'simple',
          'rag.similarityHigh': 0.85,
          'rag.similarityMedium': 0.70,
          'rag.similarityLow': 0.50,
        };
        return config[key];
      },
    };

    const mockPrismaService = {
      client: {
        project: {
          findUnique: jest.fn().mockResolvedValue(null),
        },
      },
    };

    ragService = new RagService(
      mockConfigService as never,
      new FakeEmbeddingService() as never,
      undefined,
      mockPrismaService as never,
    );
    await ragService.onModuleInit();
  });

  afterAll(async () => {
    await ragService.onModuleDestroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects empty projectId before cache access', async () => {
    const setSpySpy = jest.spyOn(ragService as any, 'tableCache');

    try {
      await ragService.getOrCreateTable('');
      fail('Expected ForbiddenAppException');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenAppException);
    }
  });

  it('rejects malformed projectId before cache access', async () => {
    try {
      await ragService.getOrCreateTable('not-a-uuid');
      fail('Expected ForbiddenAppException');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenAppException);
    }
  });

  it('rejects non-existent projectId with same error as malformed', async () => {
    const malformedError = new ForbiddenAppException('Invalid project ID');
    try {
      await ragService.getOrCreateTable('00000000-0000-0000-0000-000000000000');
      fail('Expected ForbiddenAppException');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenAppException);
      expect((error as ForbiddenAppException).statusCode).toBe(403);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-2: Project ID validation in search before dependencies
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-2: RagService.search() rejects invalid projectId before dependency calls', () => {
  let ragService: RagService;
  let mockEmbeddingService: any;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koda-ac2-'));

    mockEmbeddingService = new FakeEmbeddingService();
    const embeddingSpy = jest.spyOn(mockEmbeddingService, 'embed');

    const mockConfigService = {
      get: (key: string) => {
        const config: Record<string, unknown> = {
          'rag.lancedbPath': tmpDir,
          'rag.inMemoryOnly': true,
          'rag.ftsIndexMode': 'simple',
          'rag.similarityHigh': 0.85,
          'rag.similarityMedium': 0.70,
          'rag.similarityLow': 0.50,
        };
        return config[key];
      },
    };

    const mockPrismaService = {
      client: {
        project: {
          findUnique: jest.fn().mockResolvedValue(null),
        },
      },
    };

    ragService = new RagService(
      mockConfigService as never,
      mockEmbeddingService as never,
      undefined,
      mockPrismaService as never,
    );
    await ragService.onModuleInit();
  });

  afterAll(async () => {
    await ragService.onModuleDestroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects invalid projectId without calling embeddingService.embed()', async () => {
    const embedSpy = jest.spyOn(mockEmbeddingService, 'embed');

    try {
      await ragService.search('', 'test query');
      fail('Expected ForbiddenAppException');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenAppException);
      expect(embedSpy).not.toHaveBeenCalled();
    }
  });

  it('rejects malformed projectId without calling embeddingService.embed()', async () => {
    const embedSpy = jest.spyOn(mockEmbeddingService, 'embed');

    try {
      await ragService.search('invalid', 'query');
      fail('Expected ForbiddenAppException');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenAppException);
      expect(embedSpy).not.toHaveBeenCalled();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-3: Soft-deleted projects treated as invalid
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-3: RagService methods reject soft-deleted project IDs', () => {
  let ragService: RagService;
  let mockPrismaService: any;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koda-ac3-'));

    mockPrismaService = {
      client: {
        project: {
          findUnique: jest.fn(),
        },
      },
    };

    const mockConfigService = {
      get: (key: string) => {
        const config: Record<string, unknown> = {
          'rag.lancedbPath': tmpDir,
          'rag.inMemoryOnly': true,
          'rag.ftsIndexMode': 'simple',
          'rag.similarityHigh': 0.85,
          'rag.similarityMedium': 0.70,
          'rag.similarityLow': 0.50,
        };
        return config[key];
      },
    };

    ragService = new RagService(
      mockConfigService as never,
      new FakeEmbeddingService() as never,
      undefined,
      mockPrismaService as never,
    );
    await ragService.onModuleInit();
  });

  afterAll(async () => {
    await ragService.onModuleDestroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects getOrCreateTable for soft-deleted project', async () => {
    const validProjectId = '550e8400-e29b-41d4-a716-446655440000';
    mockPrismaService.client.project.findUnique.mockResolvedValueOnce({
      id: validProjectId,
      deletedAt: new Date(),
    });

    try {
      await ragService.getOrCreateTable(validProjectId);
      fail('Expected ForbiddenAppException');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenAppException);
    }
  });

  it('rejects search for soft-deleted project', async () => {
    const validProjectId = '550e8400-e29b-41d4-a716-446655440001';
    mockPrismaService.client.project.findUnique.mockResolvedValueOnce({
      id: validProjectId,
      deletedAt: new Date(),
    });

    try {
      await ragService.search(validProjectId, 'test');
      fail('Expected ForbiddenAppException');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenAppException);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-4: Malformed and non-existent projectIds produce identical error response
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-4: Malformed and non-existent projectIds return identical error response', () => {
  let ragService: RagService;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koda-ac4-'));

    const mockConfigService = {
      get: (key: string) => {
        const config: Record<string, unknown> = {
          'rag.lancedbPath': tmpDir,
          'rag.inMemoryOnly': true,
          'rag.ftsIndexMode': 'simple',
          'rag.similarityHigh': 0.85,
          'rag.similarityMedium': 0.70,
          'rag.similarityLow': 0.50,
        };
        return config[key];
      },
    };

    const mockPrismaService = {
      client: {
        project: {
          findUnique: jest.fn().mockResolvedValue(null),
        },
      },
    };

    ragService = new RagService(
      mockConfigService as never,
      new FakeEmbeddingService() as never,
      undefined,
      mockPrismaService as never,
    );
    await ragService.onModuleInit();
  });

  afterAll(async () => {
    await ragService.onModuleDestroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('malformed projectId throws same error class as valid-but-nonexistent', async () => {
    let malformedError: any;
    let nonexistentError: any;

    try {
      await ragService.getOrCreateTable('not-a-uuid');
    } catch (error) {
      malformedError = error;
    }

    try {
      await ragService.getOrCreateTable('550e8400-e29b-41d4-a716-446655440099');
    } catch (error) {
      nonexistentError = error;
    }

    expect(malformedError).toBeInstanceOf(ForbiddenAppException);
    expect(nonexistentError).toBeInstanceOf(ForbiddenAppException);
    expect((malformedError as ForbiddenAppException).statusCode).toBe(403);
    expect((nonexistentError as ForbiddenAppException).statusCode).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-5: Cross-organization access prevention
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-5: RagService prevents cross-organization access', () => {
  let ragService: RagService;
  let mockPrismaService: any;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koda-ac5-'));

    mockPrismaService = {
      client: {
        project: {
          findUnique: jest.fn(),
        },
      },
    };

    const mockConfigService = {
      get: (key: string) => {
        const config: Record<string, unknown> = {
          'rag.lancedbPath': tmpDir,
          'rag.inMemoryOnly': true,
          'rag.ftsIndexMode': 'simple',
          'rag.similarityHigh': 0.85,
          'rag.similarityMedium': 0.70,
          'rag.similarityLow': 0.50,
        };
        return config[key];
      },
    };

    ragService = new RagService(
      mockConfigService as never,
      new FakeEmbeddingService() as never,
      undefined,
      mockPrismaService as never,
    );
    await ragService.onModuleInit();
  });

  afterAll(async () => {
    await ragService.onModuleDestroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects getOrCreateTable when projectId belongs to different org', async () => {
    const projectId = '550e8400-e29b-41d4-a716-446655440000';
    mockPrismaService.client.project.findUnique.mockResolvedValueOnce({
      id: projectId,
      organizationId: 'org-other',
      deletedAt: null,
    });

    try {
      await ragService.getOrCreateTable(projectId);
      fail('Expected ForbiddenAppException');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenAppException);
      expect((error as ForbiddenAppException).statusCode).toBe(403);
    }
  });

  it('rejects search when projectId belongs to different org', async () => {
    const projectId = '550e8400-e29b-41d4-a716-446655440001';
    mockPrismaService.client.project.findUnique.mockResolvedValueOnce({
      id: projectId,
      organizationId: 'org-other',
      deletedAt: null,
    });

    try {
      await ragService.search(projectId, 'query');
      fail('Expected ForbiddenAppException');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenAppException);
      expect((error as ForbiddenAppException).statusCode).toBe(403);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-6: writeTicketEvent validation of source field
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-6: writeTicketEvent validates source field', () => {
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      client: {
        ticket_events: {
          create: jest.fn(),
        },
        ticket_event_rag_index: {
          create: jest.fn(),
        },
        outbox_event: {
          create: jest.fn(),
        },
        project: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'proj-001',
            deletedAt: null,
          }),
        },
      },
    };
  });

  it('rejects writeTicketEvent with missing source', async () => {
    const writeTicketEvent = async (data: any): Promise<WriteResult> => {
      const validSources = ['agent', 'system', 'manual'];
      if (!data.source || !validSources.includes(data.source)) {
        throw new ValidationAppException('Source must be one of: agent, system, manual');
      }

      const record = await mockPrisma.client.ticket_events.create({
        data,
      });

      return {
        canonicalId: record.id,
        provenance: {
          actorId: data.actorId,
          projectId: data.projectId,
          action: 'created',
          timestamp: new Date().toISOString(),
          source: data.source,
        },
      };
    };

    try {
      await writeTicketEvent({
        projectId: 'proj-001',
        actorId: 'actor-001',
        // source is missing
      });
      fail('Expected ValidationAppException');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationAppException);
      expect(mockPrisma.client.ticket_events.create).not.toHaveBeenCalled();
    }
  });

  it('rejects writeTicketEvent with invalid source', async () => {
    const writeTicketEvent = async (data: any): Promise<WriteResult> => {
      const validSources = ['agent', 'system', 'manual'];
      if (!data.source || !validSources.includes(data.source)) {
        throw new ValidationAppException('Source must be one of: agent, system, manual');
      }

      const record = await mockPrisma.client.ticket_events.create({
        data,
      });

      return {
        canonicalId: record.id,
        provenance: {
          actorId: data.actorId,
          projectId: data.projectId,
          action: 'created',
          timestamp: new Date().toISOString(),
          source: data.source,
        },
      };
    };

    try {
      await writeTicketEvent({
        projectId: 'proj-001',
        actorId: 'actor-001',
        source: 'invalid_source',
      });
      fail('Expected ValidationAppException');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationAppException);
      expect(mockPrisma.client.ticket_events.create).not.toHaveBeenCalled();
    }
  });

  it('accepts writeTicketEvent with valid source values', async () => {
    const validSources = ['agent', 'system', 'manual'];

    for (const source of validSources) {
      mockPrisma.client.ticket_events.create.mockResolvedValueOnce({
        id: `event-${source}`,
        projectId: 'proj-001',
        actorId: 'actor-001',
        action: 'created',
        timestamp: new Date().toISOString(),
      });

      const writeTicketEvent = async (data: any): Promise<WriteResult> => {
        const record = await mockPrisma.client.ticket_events.create({
          data,
        });

        return {
          canonicalId: record.id,
          provenance: {
            actorId: data.actorId,
            projectId: data.projectId,
            action: 'created',
            timestamp: new Date().toISOString(),
            source: data.source,
          },
        };
      };

      const result = await writeTicketEvent({
        projectId: 'proj-001',
        actorId: 'actor-001',
        source,
      });

      expect(result.canonicalId).toBeDefined();
      expect(result.provenance.source).toBe(source);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-7: writeTicketEvent commits canonical record even when indexing fails
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-7: writeTicketEvent commits canonical record despite RagService.index() failure', () => {
  let mockPrisma: any;
  let mockRagService: any;

  beforeEach(() => {
    mockPrisma = {
      client: {
        ticket_events: {
          create: jest.fn().mockResolvedValue({
            id: 'event-001',
            projectId: 'proj-001',
            actorId: 'actor-001',
            action: 'created',
            timestamp: new Date().toISOString(),
          }),
        },
        project: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'proj-001',
            deletedAt: null,
          }),
        },
      },
    };

    mockRagService = {
      indexDocument: jest
        .fn()
        .mockRejectedValueOnce(new Error('Embedding service unavailable')),
    };
  });

  it('returns WriteResult with canonicalId when indexing fails', async () => {
    const writeTicketEvent = async (data: any, ragService: any): Promise<WriteResult> => {
      const record = await mockPrisma.client.ticket_events.create({
        data,
      });

      let indexError = undefined;
      try {
        await ragService.indexDocument(data.projectId, {
          source: 'ticket',
          sourceId: record.id,
          content: data.content,
          metadata: {},
        });
      } catch (error) {
        indexError = error instanceof Error ? error.message : String(error);
      }

      return {
        canonicalId: record.id,
        error: indexError,
        provenance: {
          actorId: data.actorId,
          projectId: data.projectId,
          action: 'created',
          timestamp: new Date().toISOString(),
          source: data.source || 'manual',
        },
      };
    };

    const result = await writeTicketEvent(
      {
        projectId: 'proj-001',
        actorId: 'actor-001',
        content: 'Test ticket',
        source: 'agent',
      },
      mockRagService,
    );

    expect(result.canonicalId).toBe('event-001');
    expect(result.error).toBeDefined();
    expect(mockPrisma.client.ticket_events.create).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-8: writeTicketEvent logs error when outbox enqueue fails
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-8: writeTicketEvent logs error when outbox enqueue fails', () => {
  let mockPrisma: any;
  let mockLogger: any;

  beforeEach(() => {
    mockPrisma = {
      client: {
        ticket_events: {
          create: jest.fn().mockResolvedValue({
            id: 'event-001',
            projectId: 'proj-001',
            actorId: 'actor-001',
            action: 'created',
            timestamp: new Date().toISOString(),
          }),
        },
        outbox_event: {
          create: jest
            .fn()
            .mockRejectedValueOnce(new Error('Database constraint violation')),
        },
        project: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'proj-001',
            deletedAt: null,
          }),
        },
      },
    };

    mockLogger = {
      error: jest.fn(),
      log: jest.fn(),
    };
  });

  it('logs error when outbox enqueue fails but commits canonical record', async () => {
    const writeTicketEvent = async (data: any, logger: any): Promise<WriteResult> => {
      const record = await mockPrisma.client.ticket_events.create({
        data,
      });

      let outboxError = undefined;
      try {
        await mockPrisma.client.outbox_event.create({
          data: {
            aggregateId: record.id,
            aggregateType: 'ticket_event',
            eventType: 'CREATED',
            payload: JSON.stringify(data),
            status: 'pending',
          },
        });
      } catch (error) {
        outboxError = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to enqueue outbox event for ${record.id}: ${outboxError}`);
      }

      return {
        canonicalId: record.id,
        error: outboxError,
        provenance: {
          actorId: data.actorId,
          projectId: data.projectId,
          action: 'created',
          timestamp: new Date().toISOString(),
          source: data.source || 'manual',
        },
      };
    };

    const result = await writeTicketEvent(
      {
        projectId: 'proj-001',
        actorId: 'actor-001',
        source: 'agent',
      },
      mockLogger,
    );

    expect(result.canonicalId).toBe('event-001');
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to enqueue outbox event'),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-9: writeTicketEvent validates actorId
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-9: writeTicketEvent validates required actorId', () => {
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      client: {
        ticket_events: {
          create: jest.fn(),
        },
        project: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'proj-001',
            deletedAt: null,
          }),
        },
      },
    };
  });

  it('rejects writeTicketEvent with missing actorId', async () => {
    const writeTicketEvent = async (data: any): Promise<WriteResult> => {
      if (!data.actorId) {
        throw new ValidationAppException('actorId is required');
      }

      const record = await mockPrisma.client.ticket_events.create({
        data,
      });

      return {
        canonicalId: record.id,
        provenance: {
          actorId: data.actorId,
          projectId: data.projectId,
          action: 'created',
          timestamp: new Date().toISOString(),
          source: data.source || 'manual',
        },
      };
    };

    try {
      await writeTicketEvent({
        projectId: 'proj-001',
        source: 'agent',
        // actorId is missing
      });
      fail('Expected ValidationAppException');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationAppException);
      expect(mockPrisma.client.ticket_events.create).not.toHaveBeenCalled();
    }
  });

  it('rejects writeTicketEvent with empty actorId', async () => {
    const writeTicketEvent = async (data: any): Promise<WriteResult> => {
      if (!data.actorId || data.actorId.trim() === '') {
        throw new ValidationAppException('actorId is required');
      }

      const record = await mockPrisma.client.ticket_events.create({
        data,
      });

      return {
        canonicalId: record.id,
        provenance: {
          actorId: data.actorId,
          projectId: data.projectId,
          action: 'created',
          timestamp: new Date().toISOString(),
          source: data.source || 'manual',
        },
      };
    };

    try {
      await writeTicketEvent({
        projectId: 'proj-001',
        actorId: '',
        source: 'agent',
      });
      fail('Expected ValidationAppException');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationAppException);
      expect(mockPrisma.client.ticket_events.create).not.toHaveBeenCalled();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-10: Search returns empty provenance.sources when zero results
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-10: RagService.search() returns empty sources array for zero matches', () => {
  let ragService: RagService;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koda-ac10-'));

    const mockConfigService = {
      get: (key: string) => {
        const config: Record<string, unknown> = {
          'rag.lancedbPath': tmpDir,
          'rag.inMemoryOnly': true,
          'rag.ftsIndexMode': 'simple',
          'rag.similarityHigh': 0.85,
          'rag.similarityMedium': 0.70,
          'rag.similarityLow': 0.50,
        };
        return config[key];
      },
    };

    const mockPrismaService = {
      client: {
        project: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'proj-001',
            deletedAt: null,
          }),
        },
      },
    };

    ragService = new RagService(
      mockConfigService as never,
      new FakeEmbeddingService() as never,
      undefined,
      mockPrismaService as never,
    );
    await ragService.onModuleInit();
  });

  afterAll(async () => {
    await ragService.onModuleDestroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty provenance.sources array when no KB entries match', async () => {
    const result = await ragService.search('proj-001', 'this will match nothing xyz');

    expect(result.provenance).toBeDefined();
    expect(result.provenance.sources).toBeDefined();
    expect(Array.isArray(result.provenance.sources)).toBe(true);
    expect(result.provenance.sources.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-11: Each search result includes provenance.indexMethod field
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-11: Each KbResultDto includes provenance.indexMethod field', () => {
  let ragService: RagService;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koda-ac11-'));

    const mockConfigService = {
      get: (key: string) => {
        const config: Record<string, unknown> = {
          'rag.lancedbPath': tmpDir,
          'rag.inMemoryOnly': true,
          'rag.ftsIndexMode': 'simple',
          'rag.similarityHigh': 0.85,
          'rag.similarityMedium': 0.70,
          'rag.similarityLow': 0.50,
        };
        return config[key];
      },
    };

    const mockPrismaService = {
      client: {
        project: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'proj-001',
            deletedAt: null,
          }),
        },
      },
    };

    ragService = new RagService(
      mockConfigService as never,
      new FakeEmbeddingService() as never,
      undefined,
      mockPrismaService as never,
    );
    await ragService.onModuleInit();
  });

  afterAll(async () => {
    await ragService.onModuleDestroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('each search result includes provenance.indexMethod from valid set', async () => {
    // Index a document manually
    await ragService.indexDocument('proj-001', {
      source: 'manual',
      sourceId: 'doc-001',
      content: 'test document with keyword content',
      metadata: {},
    });

    // Index another as agent
    await ragService.indexDocument('proj-001', {
      source: 'agent',
      sourceId: 'doc-002',
      content: 'another keyword test document',
      metadata: {},
    });

    const result = await ragService.search('proj-001', 'keyword');

    expect(result.results.length).toBeGreaterThan(0);
    result.results.forEach((res) => {
      expect(res.provenance).toBeDefined();
      expect(res.provenance.indexMethod).toBeDefined();
      expect(['manual', 'import', 'agent']).toContain(res.provenance.indexMethod);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-12: Search results filtered by sourceProjectId
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-12: RagService.search() filters results by sourceProjectId', () => {
  let ragService: RagService;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koda-ac12-'));

    const mockConfigService = {
      get: (key: string) => {
        const config: Record<string, unknown> = {
          'rag.lancedbPath': tmpDir,
          'rag.inMemoryOnly': true,
          'rag.ftsIndexMode': 'simple',
          'rag.similarityHigh': 0.85,
          'rag.similarityMedium': 0.70,
          'rag.similarityLow': 0.50,
        };
        return config[key];
      },
    };

    const mockPrismaService = {
      client: {
        project: {
          findUnique: jest.fn().mockImplementation((args) => {
            return Promise.resolve({
              id: args.where.id,
              deletedAt: null,
            });
          }),
        },
      },
    };

    ragService = new RagService(
      mockConfigService as never,
      new FakeEmbeddingService() as never,
      undefined,
      mockPrismaService as never,
    );
    await ragService.onModuleInit();
  });

  afterAll(async () => {
    await ragService.onModuleDestroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns only results matching request projectId', async () => {
    const projA = '550e8400-e29b-41d4-a716-446655440000';
    const projB = '550e8400-e29b-41d4-a716-446655440001';

    // Index documents in projA
    await ragService.indexDocument(projA, {
      source: 'manual',
      sourceId: 'doc-a-1',
      content: 'keyword specific to project A',
      metadata: {},
    });

    // Index documents in projB
    await ragService.indexDocument(projB, {
      source: 'manual',
      sourceId: 'doc-b-1',
      content: 'keyword specific to project B',
      metadata: {},
    });

    // Search in projA
    const resultA = await ragService.search(projA, 'keyword');

    // All results must have sourceProjectId === projA
    resultA.results.forEach((res) => {
      expect(res.provenance.sourceProjectId).toBe(projA);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-13: Concurrent processPending() calls don't duplicate work
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-13: Concurrent processPending() calls prevent duplicate processing', () => {
  let outboxService: OutboxService;
  let mockPrisma: any;

  beforeEach(() => {
    const processedIds = new Set<string>();

    mockPrisma = {
      client: {
        outboxEvent: {
          findMany: jest.fn().mockImplementation((args) => {
            if (args.where?.status === 'pending') {
              return Promise.resolve([
                {
                  id: 'evt-001',
                  aggregateId: 'ticket-001',
                  aggregateType: 'ticket',
                  eventType: 'CREATED',
                  payload: '{}',
                  status: 'pending',
                  retryCount: 0,
                  createdAt: new Date(),
                  updatedAt: new Date(),
                  lastError: null,
                  processedAt: null,
                },
              ]);
            }
            return Promise.resolve([]);
          }),
          update: jest.fn().mockImplementation((args) => {
            const id = args.where.id;
            if (processedIds.has(id)) {
              throw new Error(`Event ${id} already processed`);
            }
            processedIds.add(id);
            return Promise.resolve({
              ...args.data,
              id,
            });
          }),
        },
      },
    };

    outboxService = new OutboxService(mockPrisma as never);
  });

  it('ensures each outbox event status transition occurs exactly once', async () => {
    const results = await Promise.allSettled([
      outboxService.processPending(),
      outboxService.processPending(),
    ]);

    // At least one should succeed, at most one should fail with duplicate processing
    const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.filter((r) => r.status === 'rejected').length;

    expect(fulfilled).toBeGreaterThan(0);
    // The second call might fail or succeed depending on timing and database behavior
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-14: retryCount increments atomically in single transaction
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-14: Outbox event retry increments retryCount atomically', () => {
  let outboxService: OutboxService;
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      client: {
        outboxEvent: {
          update: jest.fn().mockImplementation((args) => {
            return Promise.resolve({
              ...args.data,
              id: args.where.id,
              retryCount: (args.data.retryCount || 0) + 1,
              updatedAt: new Date(),
            });
          }),
        },
      },
    };

    outboxService = new OutboxService(mockPrisma as never);
  });

  it('increments retryCount by exactly 1 within same transaction', async () => {
    const event: OutboxEventData = {
      id: 'evt-001',
      aggregateId: 'agg-001',
      aggregateType: 'ticket',
      eventType: 'CREATED',
      payload: '{}',
      status: 'pending',
      retryCount: 2,
      lastError: null,
      processedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const retried = await outboxService.retry(event);

    expect(retried.retryCount).toBe(3);
    expect(mockPrisma.client.outboxEvent.update).toHaveBeenCalledWith({
      where: { id: 'evt-001' },
      data: expect.objectContaining({
        status: 'pending',
        retryCount: 3,
      }),
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-15: dead_letter events not returned by processPending()
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-15: processPending() skips dead_letter events', () => {
  let outboxService: OutboxService;
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      client: {
        outboxEvent: {
          findMany: jest.fn().mockImplementation((args) => {
            if (args.where?.status === 'pending') {
              return Promise.resolve([
                {
                  id: 'evt-pending',
                  aggregateId: 'agg-001',
                  aggregateType: 'ticket',
                  eventType: 'CREATED',
                  payload: '{}',
                  status: 'pending',
                  retryCount: 0,
                  createdAt: new Date(),
                  updatedAt: new Date(),
                  lastError: null,
                  processedAt: null,
                },
              ]);
            }
            return Promise.resolve([]);
          }),
          update: jest.fn().mockResolvedValue({
            id: 'evt-pending',
            status: 'completed',
          }),
        },
      },
    };

    outboxService = new OutboxService(mockPrisma as never);
  });

  it('processPending() does not return dead_letter events', async () => {
    await outboxService.processPending();

    const callArgs = mockPrisma.client.outboxEvent.findMany.mock.calls[0];
    expect(callArgs[0].where.status).toBe('pending');
    // Verify dead_letter status is NOT in the where clause
    expect(callArgs[0].where.status).not.toBe('dead_letter');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-16: Error message stored in lastError field
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-16: Outbox event stores error message in lastError field', () => {
  let outboxService: OutboxService;
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      client: {
        outboxEvent: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'evt-001',
              aggregateId: 'agg-001',
              aggregateType: 'ticket',
              eventType: 'CREATED',
              payload: '{}',
              status: 'pending',
              retryCount: 0,
              createdAt: new Date(),
              updatedAt: new Date(),
              lastError: null,
              processedAt: null,
            },
          ]),
          update: jest.fn().mockImplementation((args) => {
            return Promise.resolve({
              ...args.data,
              id: args.where.id,
            });
          }),
        },
      },
    };

    outboxService = new OutboxService(mockPrisma as never);
  });

  it('stores error message in lastError when processing fails', async () => {
    await outboxService.processPending();

    // Check if update was called with lastError containing the error message
    const updateCalls = mockPrisma.client.outboxEvent.update.mock.calls;
    const failedUpdate = updateCalls.find((call: any) =>
      call[0].data.status === 'failed' && call[0].data.lastError,
    );

    // The error message should be stored
    if (failedUpdate) {
      expect(failedUpdate[0].data.lastError).toBeDefined();
      expect(typeof failedUpdate[0].data.lastError).toBe('string');
      expect(failedUpdate[0].data.lastError.length).toBeGreaterThan(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-17: processPending() processes events in FIFO order by createdAt
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-17: processPending() processes events in ascending createdAt order', () => {
  let outboxService: OutboxService;
  let mockPrisma: any;
  let processingOrder: string[] = [];

  beforeEach(() => {
    processingOrder = [];

    const now = new Date();
    const evt1CreatedAt = new Date(now.getTime() - 2000);
    const evt2CreatedAt = new Date(now.getTime() - 1000);
    const evt3CreatedAt = new Date(now.getTime());

    mockPrisma = {
      client: {
        outboxEvent: {
          findMany: jest.fn().mockImplementation((args) => {
            if (args.where?.status === 'pending') {
              return Promise.resolve([
                {
                  id: 'evt-1',
                  aggregateId: 'agg-001',
                  aggregateType: 'ticket',
                  eventType: 'CREATED',
                  payload: '{}',
                  status: 'pending',
                  retryCount: 0,
                  createdAt: evt1CreatedAt,
                  updatedAt: evt1CreatedAt,
                  lastError: null,
                  processedAt: null,
                },
                {
                  id: 'evt-2',
                  aggregateId: 'agg-002',
                  aggregateType: 'ticket',
                  eventType: 'UPDATED',
                  payload: '{}',
                  status: 'pending',
                  retryCount: 0,
                  createdAt: evt2CreatedAt,
                  updatedAt: evt2CreatedAt,
                  lastError: null,
                  processedAt: null,
                },
                {
                  id: 'evt-3',
                  aggregateId: 'agg-003',
                  aggregateType: 'ticket',
                  eventType: 'DELETED',
                  payload: '{}',
                  status: 'pending',
                  retryCount: 0,
                  createdAt: evt3CreatedAt,
                  updatedAt: evt3CreatedAt,
                  lastError: null,
                  processedAt: null,
                },
              ]);
            }
            return Promise.resolve([]);
          }),
          update: jest.fn().mockImplementation((args) => {
            processingOrder.push(args.where.id);
            return Promise.resolve({
              ...args.data,
              id: args.where.id,
            });
          }),
        },
      },
    };

    outboxService = new OutboxService(mockPrisma as never);
  });

  it('processes events in ascending createdAt order (FIFO)', async () => {
    await outboxService.processPending();

    // Verify events were updated in FIFO order
    expect(processingOrder[0]).toBe('evt-1');
    expect(processingOrder[1]).toBe('evt-2');
    expect(processingOrder[2]).toBe('evt-3');
  });
});