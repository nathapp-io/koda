/**
 * Production database seed.
 * Creates an initial ADMIN user if no users exist. Safe to re-run (idempotent).
 *
 * Usage:
 *   bun run seed:prod
 *   KODA_ADMIN_EMAIL=you@example.com KODA_ADMIN_PASSWORD=Secret123! bun run seed:prod
 *
 * Defaults:
 *   email:    admin@koda.local
 *   password: Admin123!
 *   name:     Admin
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const email = process.env.KODA_ADMIN_EMAIL ?? 'admin@koda.local';
  const password = process.env.KODA_ADMIN_PASSWORD ?? 'Admin123!';
  const name = process.env.KODA_ADMIN_NAME ?? 'Admin';

  const existingUser = await prisma.user.findUnique({ where: { email } });

  if (existingUser) {
    console.log(`ℹ️  User "${email}" already exists (role: ${existingUser.role}). Skipping.`);
  } else {
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: { email, name, passwordHash, role: 'ADMIN' },
    });
    console.log(`✅ Admin user created:`);
    console.log(`   Email:    ${user.email}`);
    console.log(`   Password: ${password}`);
    console.log(`   Role:     ${user.role}`);
    console.log(`   ID:       ${user.id}`);
  }

  const evalProjectId = process.env.RAG_EVAL_PROJECT_ID ?? 'proj_eval_001';
  const existingProject = await prisma.project.findUnique({ where: { id: evalProjectId } });
  if (existingProject) {
    console.log(`ℹ️  Evaluation project "${evalProjectId}" already exists. Skipping.`);
  } else {
    await prisma.project.create({
      data: {
        id: evalProjectId,
        name: 'Retrieval Evaluation',
        slug: 'eval',
        key: 'EVAL',
        description: 'Project used by the retrieval evaluation harness (US-005)',
      },
    });
    console.log(`✅ Evaluation project created: ${evalProjectId}`);
  }
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
