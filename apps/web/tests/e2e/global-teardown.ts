import fs from 'fs';
import path from 'path';

const E2E_DB = path.resolve(__dirname, '../../../../apps/api/prisma/koda-e2e.db');

/**
 * Global teardown — runs once after all E2E tests.
 * Removes the e2e test database file.
 */
export default async function globalTeardown() {
  if (fs.existsSync(E2E_DB)) {
    fs.unlinkSync(E2E_DB);
    console.log('\n🧹 Removed koda-e2e.db');
  }

  // Also remove WAL/SHM files if present
  for (const ext of ['-wal', '-shm']) {
    const f = E2E_DB + ext;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}
