import { registerAs } from '@nestjs/config';

export const ragConfig = registerAs('rag', () => ({
  embeddingProvider: process.env['EMBEDDING_PROVIDER'] ?? 'ollama',
  embeddingModel: process.env['EMBEDDING_MODEL'] ?? 'nomic-embed-text',
  ollamaBaseUrl: process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434',
  openaiApiKey: process.env['OPENAI_API_KEY'] ?? '',
  lancedbPath: process.env['LANCEDB_PATH'] ?? './lancedb',
  inMemoryOnly: process.env['RAG_IN_MEMORY_ONLY']
    ? process.env['RAG_IN_MEMORY_ONLY'].toLowerCase() === 'true'
    : process.env['NODE_ENV'] === 'test',
  ftsIndexMode: process.env['FTS_INDEX_MODE'] ?? 'simple',
  // Similarity thresholds for RRF + verdict tiers.
  // SIMILARITY_HIGH: score >= this → 'high' tier / 'likely_duplicate' verdict.
  // SIMILARITY_MEDIUM: score >= this → 'medium' tier / 'possibly_related' verdict.
  // SIMILARITY_LOW: score >= this → 'low' tier; below all three → 'none'.
  similarityHigh: parseFloat(process.env['SIMILARITY_HIGH'] ?? '0.85'),
  similarityMedium: parseFloat(process.env['SIMILARITY_MEDIUM'] ?? '0.70'),
  similarityLow: parseFloat(process.env['SIMILARITY_LOW'] ?? '0.50'),
  // FTS optimize strategy configuration
  ftsOptimizeStrategy: process.env['FTS_OPTIMIZE_STRATEGY'] ?? 'counter',
  ftsOptimizeThreshold: parseInt(process.env['FTS_OPTIMIZE_THRESHOLD'] ?? '10', 10),
  ftsOptimizeIntervalMs: parseInt(process.env['FTS_OPTIMIZE_INTERVAL_MS'] ?? '300000', 10),
}));
