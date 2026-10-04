import {
  backwardReadRange, backwardSpans, forwardReadRange, forwardSpans, ScanOptions, SpanWindow, visibleEnd,
} from './log-lines';

/** ASCII only, so a string index is a byte offset. */
const opts = (s: string, o: Partial<ScanOptions>): ScanOptions => ({ cursor: 0, size: s.length, complete: false, scanBytes: 1024, ...o });
const fwd = (s: string, o: Partial<ScanOptions> = {}): SpanWindow => {
  const all = opts(s, o);
  const r = forwardReadRange(all);
  return forwardSpans(Buffer.from(s).subarray(r.from, r.to), r.from, all);
};
const back = (s: string, o: Partial<ScanOptions> = {}): SpanWindow => {
  const all = opts(s, { cursor: s.length, ...o });
  const r = backwardReadRange(all);
  return backwardSpans(Buffer.from(s).subarray(r.from, r.to), r.from, all);
};
const texts = (s: string, w: SpanWindow) => w.spans.map((p) => s.slice(p.start, p.end));
const cuts = (w: SpanWindow) => w.spans.map((p) => p.cut);

describe('forwardSpans', () => {
  it('returns complete lines and hides the trailing partial line until complete', () => {
    const s = 'a\nbb\nccc';
    const open = fwd(s);
    expect(texts(s, open)).toEqual(['a\n', 'bb\n']);
    expect(open).toMatchObject({ linesStart: 0, linesEnd: 5, reachedEnd: true });
    const done = fwd(s, { complete: true });
    expect(texts(s, done)).toEqual(['a\n', 'bb\n', 'ccc']);
    expect(cuts(done)).toEqual([false, false, false]);
    expect(done.linesEnd).toBe(8);
  });

  it('stops at the scan bound and does not report reaching the end', () => {
    const s = 'a\nbb\nccc\n';
    const w = fwd(s, { scanBytes: 4 });
    expect(texts(s, w)).toEqual(['a\n']);
    expect(w).toMatchObject({ linesEnd: 2, reachedEnd: false });
  });

  it('walks an overlong line in cut windows without skipping or repeating a byte (R12, D336, Review Focus 1)', () => {
    const s = 'xxxxxxxxxx\ny\n';
    const seen: string[] = [];
    const flags: boolean[] = [];
    let cursor = 0;
    for (let i = 0; i < 10 && cursor < s.length; i += 1) {
      const w = fwd(s, { cursor, scanBytes: 4 });
      seen.push(...texts(s, w));
      flags.push(...cuts(w));
      expect(w.linesEnd).toBeGreaterThan(cursor);
      cursor = w.linesEnd;
    }
    expect(seen.join('')).toBe(s);
    expect(seen).toEqual(['xxxx', 'xxxx', 'xx\n', 'y\n']);
    expect(flags).toEqual([true, true, true, false]);
  });

  it('marks the first span cut when the cursor is not a line start (D336)', () => {
    const s = 'abc\ndef\n';
    const w = fwd(s, { cursor: 2 });
    expect(texts(s, w)).toEqual(['c\n', 'def\n']);
    expect(cuts(w)).toEqual([true, false]);
  });

  it('clamps a cursor past the end and handles an empty file', () => {
    const s = 'a\n';
    expect(fwd(s, { cursor: 99 })).toEqual({ spans: [], linesStart: 2, linesEnd: 2, reachedEnd: true });
    expect(fwd('', {})).toEqual({ spans: [], linesStart: 0, linesEnd: 0, reachedEnd: true });
  });

  it('cuts a trailing partial line that already fills a whole window while the stream is open (R12)', () => {
    const s = 'a\nzzzzzzzz';
    const first = fwd(s, { scanBytes: 4 });
    expect(texts(s, first)).toEqual(['a\n']);
    const next = fwd(s, { cursor: 2, scanBytes: 4 });
    expect(texts(s, next)).toEqual(['zzzz']);
    expect(cuts(next)).toEqual([true]);
    expect(next.linesEnd).toBe(6);
  });
});

describe('backwardSpans', () => {
  it('returns every line of a short stream in ascending order', () => {
    const s = 'a\nbb\nccc\n';
    const w = back(s);
    expect(texts(s, w)).toEqual(['a\n', 'bb\n', 'ccc\n']);
    expect(w).toMatchObject({ linesStart: 0, linesEnd: 9 });
  });

  it('drops the leading partial line of a window that does not start at 0', () => {
    const s = 'a\nbb\nccc\n';
    const w = back(s, { scanBytes: 5 });
    expect(texts(s, w)).toEqual(['ccc\n']);
    expect(w.linesStart).toBe(5);
  });

  it('keeps the first line when the window starts exactly at a line start', () => {
    const s = 'a\nbb\nccc\n';
    expect(texts(s, back(s, { scanBytes: 7 }))).toEqual(['bb\n', 'ccc\n']);
  });

  it('walks an overlong line backward in cut windows, every byte once (R12)', () => {
    const s = 'y\nxxxxxxxx\n';
    const pages: string[][] = [];
    let cursor = s.length;
    for (let i = 0; i < 10 && cursor > 0; i += 1) {
      const w = back(s, { cursor, scanBytes: 4 });
      pages.push(texts(s, w));
      expect(w.linesStart).toBeLessThan(cursor);
      cursor = w.linesStart;
    }
    expect(pages).toEqual([['xxx\n'], ['xxxx'], ['y\n', 'x']]);
    expect(pages.reverse().flat().join('')).toBe(s);
  });

  it('marks a span cut when it ends mid-line', () => {
    const s = 'y\nxxxxxxxx\n';
    const w = back(s, { cursor: 3, scanBytes: 4 });
    expect(cuts(w)).toEqual([false, true]);
  });

  it('returns nothing at cursor 0', () => {
    expect(back('a\n', { cursor: 0 })).toEqual({ spans: [], linesStart: 0, linesEnd: 0, reachedEnd: false });
  });
});

describe('visibleEnd (D338)', () => {
  it('is the size when complete, else the end of the last newline in the tail', () => {
    expect(visibleEnd(Buffer.from('a\nbb'), 0, 4, true)).toBe(4);
    expect(visibleEnd(Buffer.from('a\nbb'), 0, 4, false)).toBe(2);
    expect(visibleEnd(Buffer.from('zzzz'), 0, 4, false)).toBe(0);
    expect(visibleEnd(Buffer.from('zzzz'), 6, 10, false)).toBe(6);
  });
});
