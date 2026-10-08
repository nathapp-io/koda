import { PrismaPg } from '@prisma/adapter-pg';

const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Prisma 6 engine parameters that pg does not understand; `connection_limit` becomes the pool size. */
const PRISMA_ONLY_PARAMS = ['schema', 'connection_limit', 'pool_timeout', 'pgbouncer', 'statement_cache_size'];

export interface PgAdapterConfig {
  connectionString: string;
  schema?: string;
  /** Pool size, from Prisma 6's `connection_limit`; pg's default (10) when absent. */
  max?: number;
}

/**
 * Translate a Prisma 6 style DATABASE_URL for adapter-pg:
 * - `?schema=` is applied as the adapter `schema` option plus the connection `search_path` (the option
 *   alone qualifies only Prisma-generated SQL, not raw SQL);
 * - `connection_limit` becomes the pg pool `max`; the other Prisma-only parameters are dropped;
 * - `sslmode` keeps its libpq meaning (`require` encrypts without a CA check, as under Prisma 6) through
 *   pg's `uselibpqcompat`, unless the URL already chooses.
 */
export function pgAdapterConfig(databaseUrl: string): PgAdapterConfig {
  const url = new URL(databaseUrl);
  const params = url.searchParams;
  const schema = params.get('schema') || undefined;
  if (schema !== undefined && !SCHEMA_NAME.test(schema)) {
    throw new Error(`DATABASE_URL schema parameter is not a plain identifier: ${schema}`);
  }
  const limit = params.get('connection_limit');
  if (limit !== null && !/^[1-9][0-9]*$/.test(limit)) {
    throw new Error(`DATABASE_URL connection_limit is not a positive integer: ${limit}`);
  }
  for (const name of PRISMA_ONLY_PARAMS) params.delete(name);
  if (params.has('sslmode') && !params.has('uselibpqcompat')) params.set('uselibpqcompat', 'true');
  return { connectionString: url.toString(), schema, ...(limit !== null ? { max: Number(limit) } : {}) };
}

/** The only place koda builds a database adapter; every PrismaClient takes one. */
export function createPgAdapter(databaseUrl: string): PrismaPg {
  const { connectionString, schema, max } = pgAdapterConfig(databaseUrl);
  const pool = { connectionString, ...(max !== undefined ? { max } : {}) };
  if (schema === undefined) return new PrismaPg(pool);
  return new PrismaPg({ ...pool, options: `-c search_path=${schema}` }, { schema });
}
