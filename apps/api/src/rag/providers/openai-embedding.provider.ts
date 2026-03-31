import { EmbeddingProvider } from '../embedding.interface';
import { ValidationAppException } from '@nathapp/nestjs-common';

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';
  readonly dimensions = 1536;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async embed(text: string): Promise<number[]> {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: text }),
    });
    if (!response.ok) {
      throw new ValidationAppException();
    }
    const data = (await response.json()) as { data: { embedding: number[] }[] };
    return data.data[0].embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!response.ok) {
      throw new ValidationAppException();
    }
    const data = (await response.json()) as { data: { embedding: number[]; index: number }[] };
    return data.data
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }
}
