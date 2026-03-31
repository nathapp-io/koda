import { EmbeddingProvider } from '../embedding.interface';
import { ValidationAppException } from '@nathapp/nestjs-common';

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'ollama';
  readonly dimensions: number;

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    dims = 768,
  ) {
    this.dimensions = dims;
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt: text }),
    });
    if (!response.ok) {
      throw new ValidationAppException();
    }
    const data = (await response.json()) as { embedding: number[] };
    return data.embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}
