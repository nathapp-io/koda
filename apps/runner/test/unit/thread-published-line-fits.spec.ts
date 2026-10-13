import { describe, expect, test } from 'bun:test';
import { publishedLineFits } from '../../src/thread/thread-published-line';

const many = (count: number) => Array.from({ length: count }, (_, index) => `docs/${index}-${'x'.repeat(40)}.md`);

describe('publishedLineFits', () => {
  test('a small result fits', () => {
    expect(publishedLineFits(['docs/a.md'], [])).toBe(true);
  });

  test('a result whose paths exceed the stream line limit does not fit', () => {
    expect(publishedLineFits(many(2_000), [])).toBe(false);
  });

  test('ignored paths count toward the limit', () => {
    expect(publishedLineFits([], many(2_000))).toBe(false);
  });

  test('reserves worst-case sha and timestamp space at the boundary', () => {
    let count = 1;
    while (publishedLineFits(many(count + 1), [])) count += 1;
    expect(publishedLineFits(many(count), [])).toBe(true);
    expect(publishedLineFits(many(count + 1), [])).toBe(false);
  });
});
