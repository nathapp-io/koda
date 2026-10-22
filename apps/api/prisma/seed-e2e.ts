/**
 * E2E test database seed.
 * WIPES all test data, then creates a fresh admin user for Playwright E2E tests.
 *
 * The seed body lives in `prisma/seed-e2e-data.ts` (`seedE2e`), so it can be imported and asserted
 * on without running a script; this file is the runner that owns the client and the messages.
 *
 * Run via: bun run seed:e2e (DATABASE_URL=file:./prisma/koda-e2e.db)
 */
import { PrismaClient } from '../src/generated/prisma/client';
import { createPgAdapter } from '../src/prisma/pg-adapter';
import { seedE2e } from './seed-e2e-data';

const prisma = new PrismaClient({ adapter: createPgAdapter(process.env.DATABASE_URL ?? '') });

async function main() {
  console.log('🌱 Seeding E2E test database...');

  await seedE2e(prisma);

  console.log('✅ E2E seed complete — admin@koda-e2e.test / E2ePassword1!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
