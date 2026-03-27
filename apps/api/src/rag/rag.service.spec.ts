import {
  RagService,
  reciprocalRankFusion,
  simpleFtsScore,
  getSimilarityTier,
  getVerdict,
} from './rag.service';

describe('simpleFtsScore', () => {
  it('returns 0 for empty query', () => {
    expect(simpleFtsScore('some content here', '')).toBe(0);
  });

  it('returns 0 when query has no terms longer than 2 chars', () => {
    expect(simpleFtsScore('some content here', 'a b')).toBe(0);
  });

  it('returns 1 for single term full match', () => {
    expect(simpleFtsScore('authentication service error', 'auth')).toBe(1);
  });

  it('returns 1 when all query terms are in content', () => {
    const score = simpleFtsScore('null reference error in auth service', 'null auth error');
    expect(score).toBeCloseTo(1);
  });

  it('returns partial score when only some terms match', () => {
    const score = simpleFtsScore('null reference in database', 'null auth error');
    // 1 out of 3 terms match ('null')
    expect(score).toBeCloseTo(1 / 3);
  });

  it('returns 0 when no terms match', () => {
    expect(simpleFtsScore('database schema migration', 'frontend react component')).toBe(0);
  });

  it('is case-insensitive', () => {
    const score = simpleFtsScore('Auth Service Error', 'auth service');
    expect(score).toBeCloseTo(1);
  });
});

describe('reciprocalRankFusion', () => {
  it('sums RRF scores for document appearing in both lists', () => {
    const vectorRanks = [{ id: 'doc1' }, { id: 'doc2' }];
    const ftsRanks = [{ id: 'doc2' }, { id: 'doc3' }];
    const k = 60;

    const result = reciprocalRankFusion(vectorRanks, ftsRanks, k);
    const doc1 = result.find((r) => r.id === 'doc1');
    const doc2 = result.find((r) => r.id === 'doc2');
    const doc3 = result.find((r) => r.id === 'doc3');

    // doc2 appears in both lists so should have the highest combined score
    expect(doc2).toBeDefined();
    expect(doc1).toBeDefined();
    expect(doc3).toBeDefined();
    if (doc2 && doc1 && doc3) {
      expect(doc2.rrfScore).toBeGreaterThan(doc1.rrfScore);
      expect(doc2.rrfScore).toBeGreaterThan(doc3.rrfScore);
    }
  });

  it('uses k=60 by default', () => {
    const vectorRanks = [{ id: 'a' }];
    const result = reciprocalRankFusion(vectorRanks, []);
    expect(result[0].rrfScore).toBeCloseTo(1 / (60 + 0 + 1));
  });

  it('returns empty array when both lists are empty', () => {
    expect(reciprocalRankFusion([], [])).toEqual([]);
  });

  it('sorts results by descending RRF score', () => {
    const vectorRanks = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const ftsRanks = [{ id: 'b' }, { id: 'a' }];
    const result = reciprocalRankFusion(vectorRanks, ftsRanks);

    for (let i = 0; i < result.length - 1; i++) {
      expect(result[i].rrfScore).toBeGreaterThanOrEqual(result[i + 1].rrfScore);
    }
  });

  it('handles document in only one list', () => {
    const result = reciprocalRankFusion([{ id: 'solo' }], []);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('solo');
  });
});

describe('getSimilarityTier', () => {
  const high = 0.85;
  const medium = 0.70;
  const low = 0.50;

  it('returns "high" when score >= high threshold', () => {
    expect(getSimilarityTier(0.90, high, medium, low)).toBe('high');
    expect(getSimilarityTier(0.85, high, medium, low)).toBe('high');
  });

  it('returns "medium" when score >= medium but < high', () => {
    expect(getSimilarityTier(0.75, high, medium, low)).toBe('medium');
    expect(getSimilarityTier(0.70, high, medium, low)).toBe('medium');
  });

  it('returns "low" when score >= low but < medium', () => {
    expect(getSimilarityTier(0.60, high, medium, low)).toBe('low');
    expect(getSimilarityTier(0.50, high, medium, low)).toBe('low');
  });

  it('returns "none" when score < low threshold', () => {
    expect(getSimilarityTier(0.49, high, medium, low)).toBe('none');
    expect(getSimilarityTier(0, high, medium, low)).toBe('none');
  });
});

describe('getVerdict', () => {
  const high = 0.85;
  const medium = 0.70;

  it('returns "likely_duplicate" when top score >= high', () => {
    expect(getVerdict(0.90, high, medium)).toBe('likely_duplicate');
    expect(getVerdict(0.85, high, medium)).toBe('likely_duplicate');
  });

  it('returns "possibly_related" when top score >= medium but < high', () => {
    expect(getVerdict(0.75, high, medium)).toBe('possibly_related');
    expect(getVerdict(0.70, high, medium)).toBe('possibly_related');
  });

  it('returns "no_match" when top score < medium', () => {
    expect(getVerdict(0.69, high, medium)).toBe('no_match');
    expect(getVerdict(0, high, medium)).toBe('no_match');
  });
});

describe('RagService lifecycle', () => {
  it('closes LanceDB connection on module destroy', () => {
    const configService = {
      get: (key: string): unknown => {
        const config: Record<string, unknown> = {
          'rag.lancedbPath': './lancedb',
          'rag.similarityHigh': 0.85,
          'rag.similarityMedium': 0.70,
          'rag.similarityLow': 0.50,
          'rag.ftsIndexMode': 'simple',
        };
        return config[key];
      },
    };

    const ragService = new RagService(configService as never);
    const closeSpy = jest.fn();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ragService as any).db = { close: closeSpy };

    ragService.onModuleDestroy();

    expect(closeSpy).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((ragService as any).db).toBeNull();
  });
});
