import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmbeddingProvider } from './embedding.interface';
import { OllamaEmbeddingProvider } from './providers/ollama-embedding.provider';
import { OpenAIEmbeddingProvider } from './providers/openai-embedding.provider';

@Injectable()
export class EmbeddingService {
  private readonly provider: EmbeddingProvider;
  private readonly _modelName: string;

  constructor(configService: ConfigService) {
    const providerName = configService.get<string>('rag.embeddingProvider') ?? 'ollama';
    const model = configService.get<string>('rag.embeddingModel') ?? 'nomic-embed-text';
    this._modelName = model;

    if (providerName === 'openai') {
      const apiKey = configService.get<string>('rag.openaiApiKey') ?? '';
      this.provider = new OpenAIEmbeddingProvider(apiKey, model);
    } else {
      const baseUrl = configService.get<string>('rag.ollamaBaseUrl') ?? 'http://localhost:11434';
      this.provider = new OllamaEmbeddingProvider(baseUrl, model);
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
