import { EmbeddingProvider } from '../embedding.interface';

const DIMENSIONS = 768;

/** FNV-1a 32-bit hash. */
function hash(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i += 1) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic, offline embeddings for e2e runs without an embeddings server
 * (EMBEDDING_PROVIDER=fake; refused in production by rag.config). Hashed bag of
 * lower-cased words, L2-normalised: texts sharing words score higher, so search
 * still ranks lexically related documents first. No semantic meaning.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'fake';
  readonly dimensions = DIMENSIONS;

  async embed(text: string): Promise<number[]> {
    const counts = new Array<number>(DIMENSIONS).fill(0);
    const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    tokens.forEach((token) => {
      const h = hash(token);
      counts[h % DIMENSIONS] += h & 0x80000000 ? -1 : 1;
    });
    const norm = Math.sqrt(counts.reduce((sum, v) => sum + v * v, 0));
    if (norm === 0) return counts.map((_, i) => (i === 0 ? 1 : 0));
    return counts.map((v) => v / norm);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}
