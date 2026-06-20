import { Test, TestingModule } from '@nestjs/testing';
import { ValidationAppException } from '@nathapp/nestjs-common';
import { RAG_CFG, IRagConfig } from '../config/rag.config';
import { EmbeddingService } from './embedding.service';
import { OllamaEmbeddingProvider } from './providers/ollama-embedding.provider';
import { OpenAIEmbeddingProvider } from './providers/openai-embedding.provider';

function makeRagConfig(overrides: Partial<IRagConfig> = {}): IRagConfig {
  return {
    embeddingProvider: 'ollama',
    embeddingModel: 'nomic-embed-text',
    ollamaBaseUrl: 'http://localhost:11434',
    openaiApiKey: '',
    lancedbPath: './lancedb',
    inMemoryOnly: true,
    ftsIndexMode: 'simple',
    similarityHigh: 0.85,
    similarityMedium: 0.70,
    similarityLow: 0.50,
    ftsOptimizeStrategy: 'counter',
    ftsOptimizeThreshold: 10,
    ftsOptimizeIntervalMs: 300000,
    graphifyEnabledCacheTtlSec: 60,
    ...overrides,
  };
}

function buildModule(ragConfig: IRagConfig): Promise<TestingModule> {
  return Test.createTestingModule({
    providers: [
      EmbeddingService,
      {
        provide: RAG_CFG,
        useValue: ragConfig,
      },
    ],
  }).compile();
}

describe('EmbeddingService', () => {
  describe('provider factory', () => {
    it('creates OllamaEmbeddingProvider when provider is "ollama"', async () => {
      const module = await buildModule(makeRagConfig({
        embeddingProvider: 'ollama',
        embeddingModel: 'nomic-embed-text',
        ollamaBaseUrl: 'http://localhost:11434',
      }));
      const service = module.get(EmbeddingService);
      expect(service.providerName).toBe('ollama');
      expect(service.dimensions).toBe(768);
    });

    it('creates OpenAIEmbeddingProvider when provider is "openai"', async () => {
      const module = await buildModule(makeRagConfig({
        embeddingProvider: 'openai',
        embeddingModel: 'text-embedding-3-small',
        openaiApiKey: 'sk-test-key',
      }));
      const service = module.get(EmbeddingService);
      expect(service.providerName).toBe('openai');
      expect(service.dimensions).toBe(1536);
    });

    it('defaults to ollama when no provider configured', async () => {
      const module = await buildModule(makeRagConfig());
      const service = module.get(EmbeddingService);
      expect(service.providerName).toBe('ollama');
    });

    it('exposes correct model name', async () => {
      const module = await buildModule(makeRagConfig({
        embeddingProvider: 'ollama',
        embeddingModel: 'mxbai-embed-large',
        ollamaBaseUrl: 'http://localhost:11434',
      }));
      const service = module.get(EmbeddingService);
      expect(service.modelName).toBe('mxbai-embed-large');
    });
  });

  describe('OllamaEmbeddingProvider', () => {
    it('calls correct Ollama endpoint', async () => {
      const provider = new OllamaEmbeddingProvider('http://localhost:11434', 'nomic-embed-text');
      const mockEmbedding = Array.from({ length: 768 }, (_, i) => i * 0.001);

      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ embedding: mockEmbedding }),
      } as Response);

      const result = await provider.embed('test text');
      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:11434/api/embeddings',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(result).toHaveLength(768);
    });

    it('throws on non-ok response', async () => {
      const provider = new OllamaEmbeddingProvider('http://localhost:11434', 'nomic-embed-text');
      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      } as Response);

      await expect(provider.embed('test')).rejects.toThrow(ValidationAppException);
    });
  });

  describe('OpenAIEmbeddingProvider', () => {
    it('calls OpenAI embeddings endpoint with correct auth', async () => {
      const provider = new OpenAIEmbeddingProvider('sk-test', 'text-embedding-3-small');
      const mockEmbedding = Array.from({ length: 1536 }, () => 0.1);

      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [{ embedding: mockEmbedding }] }),
      } as Response);

      const result = await provider.embed('test');
      expect(fetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/embeddings',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer sk-test' }),
        }),
      );
      expect(result).toHaveLength(1536);
    });

    it('throws on non-ok response', async () => {
      const provider = new OpenAIEmbeddingProvider('sk-test', 'text-embedding-3-small');
      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      } as Response);

      await expect(provider.embed('test')).rejects.toThrow(ValidationAppException);
    });
  });
});
