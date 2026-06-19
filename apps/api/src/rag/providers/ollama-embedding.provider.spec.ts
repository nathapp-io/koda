import { OllamaEmbeddingProvider } from './ollama-embedding.provider';

const VECTOR = [0.1, 0.2, 0.3];

function mockFetch(ok: boolean, body: unknown) {
  return jest.fn().mockResolvedValue({
    ok,
    json: jest.fn().mockResolvedValue(body),
  });
}

describe('OllamaEmbeddingProvider', () => {
  let provider: OllamaEmbeddingProvider;
  let fetchSpy: jest.SpyInstance;

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
      fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(mockFetch(true, { embedding: VECTOR }) as never);
      const result = await provider.embed('hello world');
      expect(result).toEqual(VECTOR);
    });

    it('sends correct request body and URL', async () => {
      fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(mockFetch(true, { embedding: VECTOR }) as never);
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
      fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(mockFetch(false, {}) as never);
      await expect(provider.embed('fail')).rejects.toThrow();
    });
  });

  describe('embedBatch', () => {
    it('returns array of embeddings for each text', async () => {
      fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(mockFetch(true, { embedding: VECTOR }) as never);
      const result = await provider.embedBatch(['a', 'b', 'c']);
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual(VECTOR);
    });
  });
});
