/**
 * E2E test database seed.
 * WIPES all test data, then creates a fresh admin user for Playwright E2E tests.
 *
 * The seed body lives in `prisma/seed-e2e-data.ts` (`seedE2e`), so it can be imported and asserted
 * on without running a script; this file is the runner that owns the client and the messages.
 *
 * The auth fixtures the password journeys need (koda #466) are written to `$E2E_AUTH_FIXTURE_FILE`
 * when that variable is set — the Playwright config points it at a file under the OS temp directory
 * and reads it from the web e2e. Without the variable nothing is written, so a plain
 * `bun run seed:e2e` leaves no files behind.
 *
 * Run via: bun run seed:e2e (DATABASE_URL=file:./prisma/koda-e2e.db)
 */
import { writeFile } from 'node:fs/promises';
import { PrismaClient } from '../src/generated/prisma/client';
import { createPgAdapter } from '../src/prisma/pg-adapter';
import { seedE2e } from './seed-e2e-data';

const prisma = new PrismaClient({ adapter: createPgAdapter(process.env.DATABASE_URL ?? '') });

async function main() {
  console.log('🌱 Seeding E2E test database...');

  const fixture = await seedE2e(prisma);

  const fixtureFile = process.env['E2E_AUTH_FIXTURE_FILE'];
  if (fixtureFile) {
    await writeFile(fixtureFile, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
    console.log(`🔑 E2E auth fixtures written to ${fixtureFile}`);
  }

  console.log('✅ E2E seed complete — admin@koda-e2e.test / E2ePassword1!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
