import { OpenAIEmbeddingProvider } from './openai-embedding.provider';

const VECTOR_A = [0.1, 0.2, 0.3];
const VECTOR_B = [0.4, 0.5, 0.6];

function mockFetch(ok: boolean, body: unknown) {
  return jest.fn().mockResolvedValue({
    ok,
    json: jest.fn().mockResolvedValue(body),
  });
}

describe('OpenAIEmbeddingProvider', () => {
  let provider: OpenAIEmbeddingProvider;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    provider = new OpenAIEmbeddingProvider('sk-test', 'text-embedding-3-small');
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  describe('constructor', () => {
    it('sets name to openai', () => {
      expect(provider.name).toBe('openai');
    });

    it('sets dimensions to 1536', () => {
      expect(provider.dimensions).toBe(1536);
    });
  });

  describe('embed', () => {
    it('returns embedding vector on success', async () => {
      fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(
        mockFetch(true, { data: [{ embedding: VECTOR_A }] }) as never,
      );
      const result = await provider.embed('hello');
      expect(result).toEqual(VECTOR_A);
    });

    it('sends correct Authorization header', async () => {
      fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(
        mockFetch(true, { data: [{ embedding: VECTOR_A }] }) as never,
      );
      await provider.embed('test');
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.openai.com/v1/embeddings',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer sk-test' }),
        }),
      );
    });

    it('throws ValidationAppException when response is not ok', async () => {
      fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(mockFetch(false, {}) as never);
      await expect(provider.embed('fail')).rejects.toThrow();
    });
  });

  describe('embedBatch', () => {
    it('returns embeddings in index order', async () => {
      fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(
        mockFetch(true, {
          data: [
            { embedding: VECTOR_B, index: 1 },
            { embedding: VECTOR_A, index: 0 },
          ],
        }) as never,
      );
      const result = await provider.embedBatch(['first', 'second']);
      expect(result[0]).toEqual(VECTOR_A);
      expect(result[1]).toEqual(VECTOR_B);
    });

    it('sends all texts in single request body', async () => {
      fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(
        mockFetch(true, { data: [{ embedding: VECTOR_A, index: 0 }] }) as never,
      );
      await provider.embedBatch(['a', 'b']);
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.openai.com/v1/embeddings',
        expect.objectContaining({
          body: JSON.stringify({ model: 'text-embedding-3-small', input: ['a', 'b'] }),
        }),
      );
    });

    it('throws ValidationAppException when response is not ok', async () => {
      fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(mockFetch(false, {}) as never);
      await expect(provider.embedBatch(['fail'])).rejects.toThrow();
    });
  });
});
