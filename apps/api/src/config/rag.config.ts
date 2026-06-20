import { validateUtil } from '@nathapp/nestjs-common';
import { registerAs } from '@nestjs/config';
import { IsBoolean, IsNumber, IsOptional, IsString } from 'class-validator';

export const RAG_CFG = 'rag';

export interface IRagConfig {
  embeddingProvider: string;
  embeddingModel: string;
  ollamaBaseUrl: string;
  openaiApiKey: string;
  lancedbPath: string;
  inMemoryOnly: boolean;
  ftsIndexMode: string;
  similarityHigh: number;
  similarityMedium: number;
  similarityLow: number;
  ftsOptimizeStrategy: string;
  ftsOptimizeThreshold: number;
  ftsOptimizeIntervalMs: number;
  graphifyEnabledCacheTtlSec: number;
}

export class RagConfigSchema {
  @IsOptional()
  @IsString()
  EMBEDDING_PROVIDER: string;

  @IsOptional()
  @IsString()
  EMBEDDING_MODEL: string;

  @IsOptional()
  @IsString()
  OLLAMA_BASE_URL: string;

  @IsOptional()
  @IsString()
  OPENAI_API_KEY: string;

  @IsOptional()
  @IsString()
  LANCEDB_PATH: string;

  @IsOptional()
  @IsBoolean()
  RAG_IN_MEMORY_ONLY: boolean;

  @IsOptional()
  @IsString()
  FTS_INDEX_MODE: string;

  @IsOptional()
  @IsNumber()
  SIMILARITY_HIGH: number;

  @IsOptional()
  @IsNumber()
  SIMILARITY_MEDIUM: number;

  @IsOptional()
  @IsNumber()
  SIMILARITY_LOW: number;

  @IsOptional()
  @IsString()
  FTS_OPTIMIZE_STRATEGY: string;

  @IsOptional()
  @IsNumber()
  FTS_OPTIMIZE_THRESHOLD: number;

  @IsOptional()
  @IsNumber()
  FTS_OPTIMIZE_INTERVAL_MS: number;

  @IsOptional()
  @IsNumber()
  GRAPHIFY_CACHE_TTL_SEC: number;
}

export const ragConfig = registerAs(RAG_CFG, (): IRagConfig => {
  validateUtil(process.env, RagConfigSchema);
  return {
    embeddingProvider: process.env['EMBEDDING_PROVIDER'] ?? 'ollama',
    embeddingModel: process.env['EMBEDDING_MODEL'] ?? 'nomic-embed-text',
    ollamaBaseUrl: process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434',
    openaiApiKey: process.env['OPENAI_API_KEY'] ?? '',
    lancedbPath: process.env['LANCEDB_PATH'] ?? './lancedb',
    inMemoryOnly: process.env['RAG_IN_MEMORY_ONLY']
      ? process.env['RAG_IN_MEMORY_ONLY'].toLowerCase() === 'true'
      : process.env['NODE_ENV'] === 'test',
    ftsIndexMode: process.env['FTS_INDEX_MODE'] ?? 'simple',
    similarityHigh: parseFloat(process.env['SIMILARITY_HIGH'] ?? '0.85'),
    similarityMedium: parseFloat(process.env['SIMILARITY_MEDIUM'] ?? '0.70'),
    similarityLow: parseFloat(process.env['SIMILARITY_LOW'] ?? '0.50'),
    ftsOptimizeStrategy: process.env['FTS_OPTIMIZE_STRATEGY'] ?? 'counter',
    ftsOptimizeThreshold: parseInt(process.env['FTS_OPTIMIZE_THRESHOLD'] ?? '10', 10),
    ftsOptimizeIntervalMs: parseInt(process.env['FTS_OPTIMIZE_INTERVAL_MS'] ?? '300000', 10),
    graphifyEnabledCacheTtlSec: parseInt(process.env['GRAPHIFY_CACHE_TTL_SEC'] ?? '60', 10),
  };
});
