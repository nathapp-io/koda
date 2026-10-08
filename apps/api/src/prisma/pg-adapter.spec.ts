import { PrismaPg } from '@prisma/adapter-pg';
import { createPgAdapter, pgAdapterConfig } from './pg-adapter';

describe('pgAdapterConfig', () => {
  it('leaves a URL without a schema parameter unchanged', () => {
    const url = 'postgresql://u:p@db:5432/koda';
    expect(pgAdapterConfig(url)).toEqual({ connectionString: new URL(url).toString(), schema: undefined });
  });

  it('moves the Prisma 6 ?schema= parameter out of the connection string', () => {
    const config = pgAdapterConfig('postgresql://u:p@db:5432/koda?schema=scratch_1&sslmode=disable');
    expect(config.schema).toBe('scratch_1');
    expect(new URL(config.connectionString).searchParams.has('schema')).toBe(false);
    expect(new URL(config.connectionString).searchParams.get('sslmode')).toBe('disable');
  });

  it('treats an empty ?schema= as no schema', () => {
    expect(pgAdapterConfig('postgresql://u:p@db:5432/koda?schema=').schema).toBeUndefined();
  });

  it('rejects a schema that is not a plain identifier (it is spliced into search_path)', () => {
    expect(() => pgAdapterConfig('postgresql://u:p@db:5432/koda?schema=a%3Bdrop')).toThrow(/schema/);
  });

  it('rejects a value that is not a URL', () => {
    expect(() => pgAdapterConfig('not a url')).toThrow();
  });
});

describe('createPgAdapter', () => {
  it('builds a PrismaPg adapter for a plain URL', () => {
    expect(createPgAdapter('postgresql://u:p@db:5432/koda')).toBeInstanceOf(PrismaPg);
  });

  it('builds a PrismaPg adapter for a URL with a schema', () => {
    expect(createPgAdapter('postgresql://u:p@db:5432/koda?schema=scratch_1')).toBeInstanceOf(PrismaPg);
  });
});
