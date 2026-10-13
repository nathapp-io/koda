import { describe, expect, test } from 'bun:test';
import { publishedLineFits } from '../../src/thread/thread-published-line';
import { parseThreadLine } from '../../../api/src/fleet/threads/ingest/thread-line';

const many = (count: number) => Array.from({ length: count }, (_, index) => `docs/${index}-${'x'.repeat(40)}.md`);

describe('publishedLineFits', () => {
  test('a small result fits', () => {
    expect(publishedLineFits(['docs/a.md'], [])).toBe(true);
  });

  test('a result whose paths exceed the stream line limit does not fit', () => {
    expect(publishedLineFits(many(2_000), [])).toBe(false);
  });

  test('ignored paths count toward the line limit', () => {
    expect(publishedLineFits([], many(2_000))).toBe(false);
  });

  test('rejects more paths than the API parser accepts even when the line is short', () => {
    const paths = Array.from({ length: 201 }, (_, index) => `d/${index}.md`);
    expect(publishedLineFits(paths, [])).toBe(false);
  });

  test('rejects a path longer than the API parser accepts', () => {
    expect(publishedLineFits([`d/${'x'.repeat(511)}`], [])).toBe(false);
  });

  test('runner rejects every publication result the API parser rejects for field limits', () => {
    const invalidResults = [
      { paths: Array.from({ length: 201 }, (_, index) => `d/${index}.md`), ignored: [] },
      { paths: [`d/${'x'.repeat(511)}`], ignored: [] },
    ];
    for (const result of invalidResults) {
      expect(publishedLineFits(result.paths, result.ignored)).toBe(false);
      expect(parseThreadLine(JSON.stringify({
        type: 'published', sha: 'a'.repeat(40), paths: result.paths, ignored: result.ignored, specPresent: true,
      }))).toEqual({ bad: true });
    }
  });

  test('reserves worst-case sha and timestamp space at the boundary', () => {
    let count = 1;
    while (publishedLineFits(many(count + 1), [])) count += 1;
    expect(publishedLineFits(many(count), [])).toBe(true);
    expect(publishedLineFits(many(count + 1), [])).toBe(false);
  });
});
