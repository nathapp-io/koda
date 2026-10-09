import { ValidationPipe } from '@nestjs/common';
import { ArgumentMetadata } from '@nestjs/common/interfaces';
import { AssigneeQuery } from './assignee.query';

/**
 * The route takes `@Query() rawQuery: AssigneeQuery`, and `useAppGlobalPipes`
 * installs a ValidationPipe with `whitelist: true`. A property with no
 * class-validator decorator is stripped from that query object, so if `q` or
 * `limit` lost its decorators the typeahead would silently ignore the filter
 * (and `limit=51` would answer 200 instead of 400). This pins the interaction
 * against the library defaults `useAppGlobalPipes` applies.
 */
const GLOBAL_PIPE_OPTIONS = { forbidUnknownValues: false, stopAtFirstError: true, whitelist: true };

describe('AssigneeQuery through the global validation pipe', () => {
  const metadata: ArgumentMetadata = { type: 'query', metatype: AssigneeQuery, data: undefined };
  const pipe = new ValidationPipe(GLOBAL_PIPE_OPTIONS);

  it('keeps q and limit so the handler can normalize them', async () => {
    const transformed = (await pipe.transform({ q: 'ALI', limit: '2' }, metadata)) as AssigneeQuery;

    expect(AssigneeQuery.parse(transformed)).toEqual(expect.objectContaining({ q: 'ALI', limit: 2 }));
  });

  it('rejects limit=51 with a 400 before the handler runs', async () => {
    await expect(pipe.transform({ limit: '51' }, metadata)).rejects.toThrow();
  });

  it('rejects a 101-character q with a 400 before the handler runs', async () => {
    await expect(pipe.transform({ q: 'x'.repeat(101) }, metadata)).rejects.toThrow();
  });
});
