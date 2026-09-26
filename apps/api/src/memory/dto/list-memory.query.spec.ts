import { validate } from 'class-validator';
import { parseQuery } from '../../common/dto/koda-page.query';
import { ListMemoryQuery } from './list-memory.query';

async function errorProps(raw: object): Promise<string[]> {
  return (await validate(parseQuery(ListMemoryQuery, raw))).map((e) => e.property);
}

describe('ListMemoryQuery', () => {
  it('accepts valid filters', async () => {
    expect(await errorProps({ kind: 'FACT', subject: 'ticket:1', status: 'superseded', orderBy: 'updatedAt' })).toEqual([]);
  });

  it.each([
    [{ kind: 'NOPE' }, 'kind'],
    [{ status: 'deleted' }, 'status'],
    [{ orderBy: 'id' }, 'orderBy'],
    [{ size: '101' }, 'size'],
  ])('rejects %j', async (raw, prop) => {
    expect(await errorProps(raw)).toContain(prop);
  });
});
