import { Injectable, Inject } from '@nestjs/common';
import { RAG_CFG, IRagConfig } from '../config/rag.config';
import { EmbeddingProvider } from './embedding.interface';
import { OllamaEmbeddingProvider } from './providers/ollama-embedding.provider';
import { OpenAIEmbeddingProvider } from './providers/openai-embedding.provider';

@Injectable()
export class EmbeddingService {
  private readonly provider: EmbeddingProvider;
  private readonly _modelName: string;

  constructor(@Inject(RAG_CFG) ragConfig: IRagConfig) {
    const { embeddingProvider, embeddingModel, openaiApiKey, ollamaBaseUrl } = ragConfig;
    this._modelName = embeddingModel;

    if (embeddingProvider === 'openai') {
      this.provider = new OpenAIEmbeddingProvider(openaiApiKey, embeddingModel);
    } else {
      this.provider = new OllamaEmbeddingProvider(ollamaBaseUrl, embeddingModel);
    }
  }

  get dimensions(): number {
    return this.provider.dimensions;
  }

  get providerName(): string {
    return this.provider.name;
  }

  get modelName(): string {
    return this._modelName;
  }

  async embed(text: string): Promise<number[]> {
    return this.provider.embed(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return this.provider.embedBatch(texts);
  }
}
