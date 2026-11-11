/**
 * Provision once for the entire run, not once per worker-batch project.
 * Vitest initializes the root project's setup even when only child projects
 * contain selected files. The returned cleanup belongs to that root setup only.
 */
import type { TestProject } from 'vitest/node';
import globalSetup from './global-setup';
import globalTeardown from './global-teardown';

export async function setup(
  project: Pick<TestProject, 'isRootProject'>,
): Promise<(() => Promise<void>) | undefined> {
  if (!project.isRootProject()) return;
  await globalSetup();
  return globalTeardown;
}
