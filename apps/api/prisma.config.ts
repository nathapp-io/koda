import type { PrismaConfig } from 'prisma';

/**
 * Prisma 7 CLI config: schema, migrations and the datasource URL (moved out of schema.prisma).
 * It must not import runtime modules: the api image runs `prisma migrate deploy` from /app, where
 * only production dependencies are installed. `.env` is loaded by Bun, by jest's setup or by the
 * container, never here.
 */
export default {
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL ?? '' },
} satisfies PrismaConfig;
