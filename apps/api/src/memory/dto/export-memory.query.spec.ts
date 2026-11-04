import { validate } from 'class-validator';
import { parseQuery } from '../../common/dto/koda-page.query';
import { ExportMemoryQuery, MEMORY_EXPORT_TAKE_DEFAULT, MEMORY_EXPORT_TAKE_MAX } from './export-memory.query';

/** The DTO a request's raw query is parsed into, and the properties `class-validator` refuses. */
const errorsFor = async (raw: object): Promise<string[]> =>
  (await validate(parseQuery(ExportMemoryQuery, raw))).map((error) => error.property);

describe('ExportMemoryQuery (memory-notes US-006)', () => {
  it('AC-3: an omitted take resolves to the 100-row default', () => {
    expect(parseQuery(ExportMemoryQuery, {}).take).toBe(MEMORY_EXPORT_TAKE_DEFAULT);
    expect(MEMORY_EXPORT_TAKE_DEFAULT).toBe(100);
    expect(MEMORY_EXPORT_TAKE_MAX).toBe(500);
  });

  it('AC-3: a query-string take is parsed into a number', () => {
    expect(parseQuery(ExportMemoryQuery, { take: '250' }).take).toBe(250);
  });

  it.each([['0'], ['501'], ['1.5'], ['-1'], ['abc']])('AC-3: take %j fails validation on take', async (take) => {
    expect(await errorsFor({ take })).toContain('take');
  });

  it.each([['1'], ['100'], ['500']])('AC-3: take %j is accepted', async (take) => {
    expect(await errorsFor({ take })).toEqual([]);
    expect(parseQuery(ExportMemoryQuery, { take }).take).toBe(Number(take));
  });

  it('AC-3: an omitted or a set since validates', async () => {
    expect(await errorsFor({})).toEqual([]);
    expect(await errorsFor({ since: 'MjAyNi0xMS0yMVQwOTowMzowMC4xMjNafG1lbS0wMQ' })).toEqual([]);
    expect(parseQuery(ExportMemoryQuery, { since: 'abc' }).since).toBe('abc');
  });

  it('AC-3: a repeated since is refused — the cursor is one value', async () => {
    expect(await errorsFor({ since: ['a', 'b'] })).toContain('since');
  });
});
