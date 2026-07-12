import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { SearchSymbolsQueryDto } from './search-symbols.dto';

describe('SearchSymbolsQueryDto', () => {
  it('accepts a minimal valid query with only projectSlug', async () => {
    const dto = plainToInstance(SearchSymbolsQueryDto, { projectSlug: 'my-project' });

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('accepts optional q, file, page, and limit', async () => {
    const dto = plainToInstance(SearchSymbolsQueryDto, {
      projectSlug: 'my-project',
      q: 'getSymbol',
      file: 'src/code-intel',
      page: '2',
      limit: '20',
    });

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.page).toBe(2);
    expect(dto.limit).toBe(20);
  });

  it('rejects a missing projectSlug', async () => {
    const dto = plainToInstance(SearchSymbolsQueryDto, {});

    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.find((error) => error.property === 'projectSlug')).toBeDefined();
  });

  it('rejects a non-numeric page', async () => {
    const dto = plainToInstance(SearchSymbolsQueryDto, { projectSlug: 'my-project', page: 'not-a-number' });

    const errors = await validate(dto);
    const pageError = errors.find((error) => error.property === 'page');
    expect(pageError?.constraints).toHaveProperty('isInt');
  });
});
