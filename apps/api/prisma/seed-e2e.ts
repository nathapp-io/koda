/**
 * E2E test database seed.
 * WIPES all test data, then creates a fresh admin user for Playwright E2E tests.
 *
 * Run via: bun run seed:e2e (DATABASE_URL=file:./prisma/koda-e2e.db)
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding E2E test database...');

  // Wipe all test data so hardcoded keys/slugs do not conflict across runs.
  // Order: deepest relations first to satisfy FK constraints.
  await prisma.ticketActivity.deleteMany();
  await prisma.comment.deleteMany();
  await prisma.ticketLabel.deleteMany();
  await prisma.ticket.deleteMany();
  await prisma.label.deleteMany();
  await prisma.agentRoleEntry.deleteMany();
  await prisma.agentCapabilityEntry.deleteMany();
  await prisma.webhook.deleteMany();
  await prisma.project.deleteMany();
  await prisma.agent.deleteMany();
  await prisma.user.deleteMany();

  const passwordHash = await bcrypt.hash('E2ePassword1!', 10);

  await prisma.user.create({
    data: {
      email: 'admin@koda-e2e.test',
      name: 'E2E Admin',
      passwordHash,
      role: 'ADMIN',
    },
  });

  console.log('✅ E2E seed complete — admin@koda-e2e.test / E2ePassword1!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
