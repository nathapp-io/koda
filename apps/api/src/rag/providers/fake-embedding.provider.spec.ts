import { FakeEmbeddingProvider } from './fake-embedding.provider';

const dot = (a: number[], b: number[]) => a.reduce((sum, v, i) => sum + v * b[i], 0);

describe('FakeEmbeddingProvider', () => {
  const provider = new FakeEmbeddingProvider();

  it('is named "fake" and matches the default 768 dimensions', () => {
    expect(provider.name).toBe('fake');
    expect(provider.dimensions).toBe(768);
  });

  it('is deterministic and unit-length', async () => {
    const a = await provider.embed('JWT tokens expire after 7 days');
    const b = await provider.embed('JWT tokens expire after 7 days');
    expect(a).toEqual(b);
    expect(a).toHaveLength(768);
    expect(dot(a, a)).toBeCloseTo(1, 6);
  });

  it('scores texts sharing words above unrelated texts (case-insensitive)', async () => {
    const doc = await provider.embed('The login endpoint uses JWT tokens for authentication.');
    const related = await provider.embed('jwt token authentication');
    const unrelated = await provider.embed('bananas grow in tropical climates');
    expect(dot(doc, related)).toBeGreaterThan(dot(doc, unrelated));
  });

  it('returns a valid unit vector for text without words', async () => {
    const empty = await provider.embed('  ... ');
    expect(dot(empty, empty)).toBeCloseTo(1, 6);
  });

  it('embedBatch matches embed per text', async () => {
    const texts = ['alpha beta', 'gamma'];
    expect(await provider.embedBatch(texts)).toEqual([
      await provider.embed(texts[0]),
      await provider.embed(texts[1]),
    ]);
  });
});
