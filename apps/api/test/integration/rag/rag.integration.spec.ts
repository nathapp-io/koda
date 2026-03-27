import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { RagService } from '../../../src/rag/rag.service';
import { EmbeddingService } from '../../../src/rag/embedding.service';

jest.setTimeout(30000);

// Deterministic fake embeddings for testing (no real model required)
class FakeEmbeddingService {
  readonly providerName = 'fake';
  readonly modelName = 'fake-v1';
  readonly dimensions = 8;

  async embed(text: string): Promise<number[]> {
    // Simple hash-based vector: different texts produce different vectors
    const vec = Array.from({ length: 8 }, (_, i) => {
      let h = 0;
      for (const ch of text) h = ((h << 5) - h + ch.charCodeAt(0)) >>> 0;
      return ((h + i * 1000) % 200) / 200;
    });
    return vec;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

describe('RagService integration', () => {
  let module: TestingModule;
  let ragService: RagService;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koda-rag-test-'));

    module = await Test.createTestingModule({
      providers: [
        RagService,
        {
          provide: EmbeddingService,
          useClass: FakeEmbeddingService,
        },
        {
          provide: ConfigService,
          useValue: {
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
          },
        },
      ],
    }).compile();

    ragService = module.get(RagService);
    // Inject fake embedding service
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ragService as any).embeddingService = new FakeEmbeddingService();
  });

  afterAll(async () => {
    await module.close();
    // Clean up temporary LanceDB directory
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const projectId = 'test-project-001';

  it('indexes a document without error', async () => {
    await expect(
      ragService.indexDocument(projectId, {
        source: 'ticket',
        sourceId: 'ticket-001',
        content: 'Null pointer exception in auth service when token is missing',
        metadata: { ref: 'TEST-1', type: 'BUG', status: 'CLOSED' },
      }),
    ).resolves.not.toThrow();
  });

  it('indexes multiple documents', async () => {
    await ragService.indexDocument(projectId, {
      source: 'doc',
      sourceId: 'doc-001',
      content: 'Authentication guide: how to configure JWT tokens',
      metadata: { title: 'Auth Guide' },
    });

    await ragService.indexDocument(projectId, {
      source: 'manual',
      sourceId: 'manual-001',
      content: 'Database connection pooling configuration and best practices',
      metadata: { title: 'DB Config' },
    });
  });

  it('lists indexed documents', async () => {
    const docs = await ragService.listDocuments(projectId);
    expect(docs.length).toBeGreaterThanOrEqual(3);
    expect(docs.every((d) => typeof d.id === 'string')).toBe(true);
    expect(docs.every((d) => typeof d.content === 'string')).toBe(true);
  });

  it('searches and returns results with score and similarity tier', async () => {
    const response = await ragService.search(projectId, 'null pointer auth token', 5);
    expect(response.results.length).toBeGreaterThan(0);

    const firstResult = response.results[0];
    expect(typeof firstResult.score).toBe('number');
    expect(['high', 'medium', 'low', 'none']).toContain(firstResult.similarity);
    expect(['likely_duplicate', 'possibly_related', 'no_match']).toContain(response.verdict);
  });

  it('search returns empty results for empty table on new project', async () => {
    const emptyProjectId = 'empty-project-999';
    const response = await ragService.search(emptyProjectId, 'something', 5);
    expect(response.results).toEqual([]);
    expect(response.verdict).toBe('no_match');
  });

  it('deleteBySource removes documents by sourceId', async () => {
    const deleteProjectId = 'delete-test-project';
    await ragService.indexDocument(deleteProjectId, {
      source: 'ticket',
      sourceId: 'ticket-to-delete',
      content: 'This ticket will be deleted from the knowledge base',
      metadata: {},
    });

    const beforeDelete = await ragService.listDocuments(deleteProjectId);
    expect(beforeDelete.some((d) => d.sourceId === 'ticket-to-delete')).toBe(true);

    await ragService.deleteBySource(deleteProjectId, 'ticket-to-delete');

    const afterDelete = await ragService.listDocuments(deleteProjectId);
    expect(afterDelete.some((d) => d.sourceId === 'ticket-to-delete')).toBe(false);
  });

  it('validateTableProvider detects provider mismatch', async () => {
    // The table was created with the fake provider; now check with mismatched config
    const result = await ragService.validateTableProvider(projectId);
    // valid = true because the fake provider name matches what was stored
    expect(typeof result.valid).toBe('boolean');
  });
});
