import type { MockInstance } from 'vitest';
import { ValidationAppException } from '@nathapp/nestjs-common';
import { OllamaEmbeddingProvider } from './ollama-embedding.provider';

const VECTOR = [0.1, 0.2, 0.3];
const VECTORS = [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6], [0.7, 0.8, 0.9]];
const BATCH_URL = 'http://localhost:11434/api/embed';
const BATCH_BODY = { model: 'nomic-embed-text', input: ['a', 'b', 'c'], truncate: true };

function mockFetch(ok: boolean, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok,
    json: vi.fn().mockResolvedValue(body),
  });
}

describe('OllamaEmbeddingProvider', () => {
  let provider: OllamaEmbeddingProvider;
  let fetchSpy: MockInstance;

  beforeEach(() => {
    provider = new OllamaEmbeddingProvider('http://localhost:11434', 'nomic-embed-text');
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  describe('constructor', () => {
    it('sets name to ollama', () => {
      expect(provider.name).toBe('ollama');
    });

    it('uses default dimensions of 768', () => {
      expect(provider.dimensions).toBe(768);
    });

    it('accepts custom dimensions', () => {
      const p = new OllamaEmbeddingProvider('http://localhost:11434', 'custom', 512);
      expect(p.dimensions).toBe(512);
    });
  });

  describe('embed', () => {
    it('returns embedding vector on success', async () => {
      fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(mockFetch(true, { embedding: VECTOR }) as never);
      const result = await provider.embed('hello world');
      expect(result).toEqual(VECTOR);
    });

    it('sends correct request body and URL', async () => {
      fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(mockFetch(true, { embedding: VECTOR }) as never);
      await provider.embed('test text');
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://localhost:11434/api/embeddings',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ model: 'nomic-embed-text', prompt: 'test text' }),
        }),
      );
    });

    it('throws ValidationAppException when response is not ok', async () => {
      fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(mockFetch(false, {}) as never);
      await expect(provider.embed('fail')).rejects.toThrow();
    });
  });

  describe('embedBatch', () => {
    it('AC-1: posts every text to /api/embed in one request and returns the vectors in order', async () => {
      fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(mockFetch(true, { embeddings: VECTORS }) as never);
      const result = await provider.embedBatch(['a', 'b', 'c']);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledWith(BATCH_URL, expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(BATCH_BODY),
      }));
      expect(result).toEqual(VECTORS);
    });

    it('AC-2: throws ValidationAppException when the response is not ok', async () => {
      fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(mockFetch(false, { embeddings: VECTORS }) as never);
      await expect(provider.embedBatch(['a', 'b', 'c'])).rejects.toBeInstanceOf(ValidationAppException);
    });

    it('AC-3: throws ValidationAppException when the response holds fewer vectors than texts', async () => {
      fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(mockFetch(true, { embeddings: [VECTORS[0]] }) as never);
      await expect(provider.embedBatch(['a', 'b'])).rejects.toBeInstanceOf(ValidationAppException);
    });

    it('AC-4: resolves [] for an empty input without calling fetch', async () => {
      fetchSpy = vi.spyOn(global, 'fetch');
      await expect(provider.embedBatch([])).resolves.toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('throws ValidationAppException when embeddings is not an array', async () => {
      fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(mockFetch(true, { embeddings: 'nope' }) as never);
      await expect(provider.embedBatch(['a'])).rejects.toBeInstanceOf(ValidationAppException);
    });

    it('throws ValidationAppException when the response is missing embeddings', async () => {
      fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(mockFetch(true, {}) as never);
      await expect(provider.embedBatch(['a'])).rejects.toBeInstanceOf(ValidationAppException);
    });

    it('keeps embed on the single-prompt route', async () => {
      fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(mockFetch(true, { embedding: VECTOR }) as never);
      await provider.embed('a');
      expect(fetchSpy).toHaveBeenCalledWith('http://localhost:11434/api/embeddings', expect.objectContaining({
        body: JSON.stringify({ model: 'nomic-embed-text', prompt: 'a' }),
      }));
    });
  });
});
