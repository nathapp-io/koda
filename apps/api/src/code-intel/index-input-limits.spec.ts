import {
  MAX_INDEX_BATCH_BYTES,
  MAX_INDEX_BATCH_FILES,
  MAX_INDEX_FILE_BYTES,
  batchSourceFiles,
  isIndexablePath,
  partitionBySize,
} from './index-input-limits';

const file = (path: string, bytes: number) => ({ path, content: 'x'.repeat(bytes) });

describe('isIndexablePath (#534)', () => {
  it.each(['src/a.ts', 'src/a.tsx', 'lib/a.mts', 'lib/a.cts', 'a.js', 'a.jsx', 'a.mjs', 'a.cjs', 'types/a.d.ts', 'SRC/A.TS'])(
    'accepts %s',
    (path) => expect(isIndexablePath(path)).toBe(true),
  );

  it.each(['bun.lock', 'openapi.json', 'README.md', 'logo.png', 'Dockerfile', 'src/a.ts.snap', 'src/ts', '.ts/readme', ''])(
    'refuses %s',
    (path) => expect(isIndexablePath(path)).toBe(false),
  );
});

describe('partitionBySize (#534)', () => {
  it('keeps a file at the cap and moves a larger one to oversized', () => {
    const atCap = file('src/at-cap.ts', MAX_INDEX_FILE_BYTES);
    const over = file('src/over.ts', MAX_INDEX_FILE_BYTES + 1);

    expect(partitionBySize([atCap, over])).toEqual({ accepted: [atCap], oversized: ['src/over.ts'] });
  });

  it('measures UTF-8 bytes, not characters', () => {
    const wide = { path: 'src/wide.ts', content: '中'.repeat(Math.floor(MAX_INDEX_FILE_BYTES / 3) + 1) };

    expect(wide.content.length).toBeLessThan(MAX_INDEX_FILE_BYTES);
    expect(partitionBySize([wide]).oversized).toEqual(['src/wide.ts']);
  });
});

describe('batchSourceFiles (#534)', () => {
  it('returns no batch for no files', () => {
    expect(batchSourceFiles([])).toEqual([]);
  });

  it('keeps a small commit in one batch, in order', () => {
    const files = [file('a.ts', 10), file('b.ts', 10), file('c.ts', 10)];

    expect(batchSourceFiles(files)).toEqual([files]);
  });

  it('starts a new batch after the file count cap', () => {
    const files = Array.from({ length: MAX_INDEX_BATCH_FILES + 1 }, (_, i) => file(`f${i}.ts`, 1));

    const batches = batchSourceFiles(files);

    expect(batches.map((batch) => batch.length)).toEqual([MAX_INDEX_BATCH_FILES, 1]);
    expect(batches.flat()).toEqual(files);
  });

  it('starts a new batch before the byte cap would be passed', () => {
    const half = Math.floor(MAX_INDEX_BATCH_BYTES / 2);
    const size = Math.min(half, MAX_INDEX_FILE_BYTES);
    const count = Math.floor(MAX_INDEX_BATCH_BYTES / size) + 1;
    const files = Array.from({ length: count }, (_, i) => file(`f${i}.ts`, size));

    const batches = batchSourceFiles(files);

    expect(batches.length).toBe(2);
    for (const batch of batches) {
      expect(batch.reduce((sum, f) => sum + Buffer.byteLength(f.content), 0)).toBeLessThanOrEqual(MAX_INDEX_BATCH_BYTES);
    }
    expect(batches.flat()).toEqual(files);
  });
});
