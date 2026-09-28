import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { parseQuery } from '../../common/dto/koda-page.query';
import { GetContextQueryDto } from './get-context-query.dto';

async function errorsFor(raw: object): Promise<string[]> {
  const errors = await validate(plainToInstance(GetContextQueryDto, raw));
  return errors.map((e) => e.property);
}

describe('GetContextQueryDto', () => {
  it('accepts an empty query (intent defaults downstream)', async () => {
    expect(await errorsFor({})).toEqual([]);
  });

  it('accepts query-string shapes and converts them', async () => {
    const raw = { intent: 'plan', tokenBudget: '500', includeGraph: 'true', ticketIds: 'a, b', repoRefs: ['r1', 'r2'] };
    expect(await errorsFor(raw)).toEqual([]);
    expect(parseQuery(GetContextQueryDto, raw)).toMatchObject({
      intent: 'plan',
      tokenBudget: 500,
      includeGraph: true,
      ticketIds: ['a', 'b'],
      repoRefs: ['r1', 'r2'],
    });
  });

  it('accepts JSON-body shapes', async () => {
    expect(await errorsFor({ intent: 'answer', tokenBudget: 500, includeCodeIntel: false, ticketIds: ['a'] })).toEqual([]);
  });

  it.each([
    [{ intent: 'hack' }, 'intent'],
    [{ tokenBudget: 'abc' }, 'tokenBudget'],
    [{ tokenBudget: '0' }, 'tokenBudget'],
    [{ tokenBudget: '1.5' }, 'tokenBudget'],
    [{ tokenBudget: '100001' }, 'tokenBudget'],
    [{ includeGraph: 'yes' }, 'includeGraph'],
    [{ query: 'x'.repeat(2001) }, 'query'],
    [{ ticketIds: Array.from({ length: 101 }, (_, i) => `t${i}`) }, 'ticketIds'],
  ])('rejects %p', async (raw, property) => {
    expect(await errorsFor(raw)).toContain(property);
  });

  it('parseQuery drops undeclared keys', () => {
    expect(parseQuery(GetContextQueryDto, { projectId: 'evil', intent: 'answer' })).not.toHaveProperty('projectId');
  });
});
