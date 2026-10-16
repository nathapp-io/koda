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

  /**
   * One `POST /api/embed` for the whole batch (Ollama's batch route). `truncate: true` lets the server cut a
   * token-oversized input instead of refusing the request. Vector length is not checked here: the caller
   * treats a wrong-length vector as a failed batch.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts, truncate: true }),
    });
    if (!response.ok) {
      throw new ValidationAppException();
    }
    const data = (await response.json()) as { embeddings?: number[][] };
    const embeddings = data.embeddings;
    if (!Array.isArray(embeddings) || embeddings.length !== texts.length || !embeddings.every(Array.isArray)) {
      throw new ValidationAppException();
    }
    return embeddings;
  }
}
