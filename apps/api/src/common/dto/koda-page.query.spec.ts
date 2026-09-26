import { validate } from 'class-validator';
import { Page } from '@nathapp/nestjs-common';
import { KodaPageQuery, parseQuery, remapPage, toPageResult } from './koda-page.query';

async function errorsFor(raw: object): Promise<string[]> {
  const errors = await validate(parseQuery(KodaPageQuery, raw));
  return errors.map((e) => e.property);
}

describe('KodaPageQuery', () => {
  it('applies defaults when nothing is sent', async () => {
    const q = parseQuery(KodaPageQuery, {});
    expect(q.current).toBe(1);
    expect(q.size).toBe(20);
    expect(await errorsFor({})).toEqual([]);
  });

  it('converts query-string numbers', () => {
    const q = parseQuery(KodaPageQuery, { current: '3', size: '5' });
    expect(q.current).toBe(3);
    expect(q.size).toBe(5);
  });

  it.each([
    [{ size: '101' }, 'size'],
    [{ size: '0' }, 'size'],
    [{ size: '2.5' }, 'size'],
    [{ current: 'abc' }, 'current'],
    [{ current: '0' }, 'current'],
    [{ current: '-1' }, 'current'],
  ])('rejects %j', async (raw, property) => {
    expect(await errorsFor(raw)).toContain(property);
  });

  it('accepts the boundary size of 100', async () => {
    expect(await errorsFor({ size: '100' })).toEqual([]);
  });
});

describe('toPageResult', () => {
  it('keeps exactly the six IPageResult fields', () => {
    const page = new Page({ current: 2, size: 2 }, 5, ['c', 'd']);
    const result = toPageResult(page);
    expect(Object.keys(result).sort()).toEqual(
      ['current', 'hasNext', 'hasPrev', 'records', 'size', 'total'],
    );
    expect(result).toEqual({ total: 5, current: 2, size: 2, hasNext: true, hasPrev: true, records: ['c', 'd'] });
    expect(JSON.stringify(result)).not.toContain('transformOptions');
  });
});

describe('remapPage', () => {
  it('maps records and keeps the counters', () => {
    const mapped = remapPage(new Page({ current: 1, size: 2 }, 3, [1, 2]), (n: number) => n * 10);
    expect(mapped).toEqual(expect.objectContaining({ total: 3, current: 1, size: 2, hasNext: true, records: [10, 20] }));
  });
});
