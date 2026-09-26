import { validate } from 'class-validator';
import { parseQuery } from '../../common/dto/koda-page.query';
import { ListTicketsQuery } from './list-tickets.query';

async function errorProps(raw: object): Promise<string[]> {
  return (await validate(parseQuery(ListTicketsQuery, raw))).map((e) => e.property);
}

describe('ListTicketsQuery', () => {
  it('accepts valid filters and inherits paging defaults', async () => {
    const q = parseQuery(ListTicketsQuery, { status: 'IN_PROGRESS', type: 'BUG', priority: 'HIGH' });
    expect(await validate(q)).toEqual([]);
    expect(q.current).toBe(1);
    expect(q.size).toBe(20);
  });

  it.each([
    [{ status: 'NOPE' }, 'status'],
    [{ type: 'NOPE' }, 'type'],
    [{ priority: 'NOPE' }, 'priority'],
    [{ unassigned: 'yes' }, 'unassigned'],
    [{ size: '101' }, 'size'],
  ])('rejects %j', async (raw, prop) => {
    expect(await errorProps(raw)).toContain(prop);
  });

  it.each([
    ['true', true],
    ['false', false],
  ])('parses unassigned=%s', (raw, expected) => {
    expect(parseQuery(ListTicketsQuery, { unassigned: raw }).unassigned).toBe(expected);
  });
});
