/**
 * Production database seed.
 * Creates a bound admin user when the configured email is absent. Safe to re-run (idempotent).
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
import { PrismaClient } from '../src/generated/prisma/client';
import { createPgAdapter } from '../src/prisma/pg-adapter';
import { seedAdminUser } from './seed-admin-data';

const prisma = new PrismaClient({ adapter: createPgAdapter(process.env.DATABASE_URL ?? '') });

async function main() {
  const email = process.env.KODA_ADMIN_EMAIL ?? 'admin@koda.local';
  const password = process.env.KODA_ADMIN_PASSWORD ?? 'Admin123!';
  const name = process.env.KODA_ADMIN_NAME ?? 'Admin';

  const outcome = await seedAdminUser(prisma, { email, name, password });

  if (!outcome.created) {
    console.log(`ℹ️  User "${email}" already exists. Skipping.`);
  } else {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: outcome.userId } });
    console.log(`✅ Admin user created:`);
    console.log(`   Email:    ${user.email}`);
    console.log(`   Password: ${password}`);
    console.log(`   Role:     ${outcome.roleKey}`);
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
