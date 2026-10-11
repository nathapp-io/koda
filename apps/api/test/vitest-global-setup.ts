/**
 * Vitest globalSetup: reuses the Jest-era setup/teardown so DB provisioning
 * (KODA_DB_TESTS=1) behaves the same under either runner.
 */
import globalSetup from './global-setup';
import globalTeardown from './global-teardown';

export async function setup(): Promise<void> {
  await globalSetup();
}

export async function teardown(): Promise<void> {
  await globalTeardown();
}
