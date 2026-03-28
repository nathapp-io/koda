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

  const existing = await prisma.user.findUnique({ where: { email } });

  if (existing) {
    console.log(`ℹ️  User "${email}" already exists (role: ${existing.role}). Skipping.`);
    return;
  }

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

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
