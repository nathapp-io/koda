import { ragConfig, IRagConfig } from './rag.config';

describe('ragConfig', () => {
  beforeEach(() => {
    Object.keys(process.env)
      .filter((k) => ['EMBEDDING_PROVIDER', 'EMBEDDING_MODEL', 'OLLAMA_BASE_URL',
        'OPENAI_API_KEY', 'LANCEDB_PATH', 'RAG_IN_MEMORY_ONLY', 'FTS_INDEX_MODE',
        'SIMILARITY_HIGH', 'SIMILARITY_MEDIUM', 'SIMILARITY_LOW',
        'FTS_OPTIMIZE_STRATEGY', 'FTS_OPTIMIZE_THRESHOLD', 'FTS_OPTIMIZE_INTERVAL_MS',
        'GRAPHIFY_CACHE_TTL_SEC'].includes(k))
      .forEach((k) => delete process.env[k]);
    process.env['NODE_ENV'] = 'test';
  });

  it('returns typed IRagConfig with defaults', () => {
    const cfg: IRagConfig = ragConfig();
    expect(cfg.embeddingProvider).toBe('ollama');
    expect(cfg.embeddingModel).toBe('nomic-embed-text');
    expect(cfg.lancedbPath).toBe('./lancedb');
    expect(cfg.inMemoryOnly).toBe(true); // NODE_ENV=test defaults to true
    expect(cfg.similarityHigh).toBe(0.85);
    expect(cfg.ftsOptimizeThreshold).toBe(10);
    expect(cfg.graphifyEnabledCacheTtlSec).toBe(60);
  });
});
