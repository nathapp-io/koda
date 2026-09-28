import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { parseQuery } from '../../common/dto/koda-page.query';
import { ListKbDocumentsQuery } from './list-kb-documents.query';

describe('ListKbDocumentsQuery', () => {
  it('defaults limit to 100', () => {
    expect(parseQuery(ListKbDocumentsQuery, {}).limit).toBe(100);
  });

  it('converts a numeric string', async () => {
    expect(await validate(plainToInstance(ListKbDocumentsQuery, { limit: '25' }))).toEqual([]);
    expect(parseQuery(ListKbDocumentsQuery, { limit: '25' }).limit).toBe(25);
  });

  it.each(['0', '501', '1000', 'abc', '2.5', '-1'])('rejects limit=%s', async (limit) => {
    const errors = await validate(plainToInstance(ListKbDocumentsQuery, { limit }));
    expect(errors.map((e) => e.property)).toEqual(['limit']);
  });
});
