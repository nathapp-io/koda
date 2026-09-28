/**
 * Apply the committed migrations to a throwaway Postgres schema, so a data
 * migration can be tested against rows written by the schema that preceded it.
 * The main test schema is created by `prisma db push` and never runs migrations.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';

export const MIGRATIONS_DIR = join(__dirname, '../../prisma/migrations');

/** Migration SQL → statements. Comment lines are dropped; no statement may contain a literal ';'. */
export function migrationStatements(migration: string): string[] {
  return readFileSync(join(MIGRATIONS_DIR, migration, 'migration.sql'), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** Every committed migration that sorts before `target`, oldest first. */
export function migrationsBefore(target: string): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{14}_/.test(name) && name < target)
    .sort();
}

export async function applyMigration(db: PrismaClient, migration: string): Promise<void> {
  for (const statement of migrationStatements(migration)) {
    await db.$executeRawUnsafe(statement);
  }
}

export interface ScratchSchema {
  db: PrismaClient;
  drop: () => Promise<void>;
}

/** A fresh schema holding every migration before `target` (target not applied). */
export async function scratchSchemaBefore(baseUrl: string, schema: string, target: string): Promise<ScratchSchema> {
  const admin = new PrismaClient({ datasources: { db: { url: baseUrl } } });
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);

  const url = new URL(baseUrl);
  url.searchParams.set('schema', schema);
  const db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  for (const migration of migrationsBefore(target)) {
    await applyMigration(db, migration);
  }

  return {
    db,
    drop: async () => {
      await db.$disconnect();
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.$disconnect();
    },
  };
}
