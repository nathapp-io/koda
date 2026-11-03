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

  // memory-notes US-003: the list route searches by full text, so `text` is part of the contract.
  it('AC-15: accepts a 100-character text and rejects one of 101 characters on text', async () => {
    expect(await errorProps({ text: 'x'.repeat(100) })).toEqual([]);
    expect(await errorProps({ text: 'x'.repeat(101) })).toContain('text');
  });

  it('AC-15: rejects an empty text on text, which is no search at all', async () => {
    expect(await errorProps({ text: '' })).toContain('text');
  });
});
