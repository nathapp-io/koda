/**
 * E2E test database seed.
 * Creates a single admin user for Playwright E2E tests.
 *
 * Run via: bun run seed:e2e (DATABASE_URL=file:./prisma/koda-e2e.db)
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding E2E test database...');

  const passwordHash = await bcrypt.hash('E2ePassword1!', 10);

  await prisma.user.upsert({
    where: { email: 'admin@koda.e2e' },
    update: {},
    create: {
      email: 'admin@koda.e2e',
      name: 'E2E Admin',
      password: passwordHash,
      role: 'ADMIN',
    },
  });

  console.log('✅ E2E seed complete — admin@koda.e2e / E2ePassword1!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
