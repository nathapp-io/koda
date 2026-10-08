import { PrismaPg } from '@prisma/adapter-pg';

const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface PgAdapterConfig {
  connectionString: string;
  schema?: string;
}

/**
 * Prisma 6 read the target schema from a `?schema=` URL parameter; adapter-pg ignores it. Take it
 * out of the URL so it can be applied as the adapter `schema` option plus the connection
 * `search_path` (the option alone qualifies only Prisma-generated SQL, not raw SQL).
 */
export function pgAdapterConfig(databaseUrl: string): PgAdapterConfig {
  const url = new URL(databaseUrl);
  const schema = url.searchParams.get('schema') || undefined;
  if (schema !== undefined && !SCHEMA_NAME.test(schema)) {
    throw new Error(`DATABASE_URL schema parameter is not a plain identifier: ${schema}`);
  }
  url.searchParams.delete('schema');
  return { connectionString: url.toString(), schema };
}

/** The only place koda builds a database adapter; every PrismaClient takes one. */
export function createPgAdapter(databaseUrl: string): PrismaPg {
  const { connectionString, schema } = pgAdapterConfig(databaseUrl);
  if (schema === undefined) return new PrismaPg({ connectionString });
  return new PrismaPg({ connectionString, options: `-c search_path=${schema}` }, { schema });
}
