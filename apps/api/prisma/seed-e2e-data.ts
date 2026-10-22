/**
 * The e2e test database seed, as an import-safe module.
 *
 * `prisma/seed-e2e.ts` is the runner that calls this; keeping the body here means the seed can be
 * imported by a spec (and asserted on) without running a script or opening a second client. The
 * module creates no client and runs nothing at import: the caller owns the client it passes in.
 *
 * Permissions P1 (US-005): the admin's access is a set of role bindings, not a legacy
 * `ProjectMember` row — the global `member` baseline plus the global `admin` binding production
 * mirrors into `User.role`, and the `project-admin` binding in the fleet project.
 */
import * as bcrypt from 'bcrypt';
import type { PrismaClient } from '../src/generated/prisma/client';
import { grantBaseline, grantRole } from '../src/permissions/test-helpers/permission-fixtures';

const ADMIN_EMAIL = 'admin@koda-e2e.test';
const ADMIN_PASSWORD = 'E2ePassword1!';

/**
 * Wipes every test table so hardcoded keys/slugs do not conflict across runs.
 * Order: deepest relations first to satisfy FK constraints.
 * Fleet first: jobs reference projects, repos and runners (events, commands, artifacts cascade).
 */
async function wipe(db: PrismaClient): Promise<void> {
  await db.fleetJob.deleteMany();
  await db.fleetRepo.deleteMany();
  await db.runner.deleteMany();
  await db.runnerEnrollment.deleteMany();
  await db.fleetActivity.deleteMany();
  await db.ticketActivity.deleteMany();
  await db.comment.deleteMany();
  await db.ticketLabel.deleteMany();
  await db.ticket.deleteMany();
  await db.label.deleteMany();
  await db.agentRoleEntry.deleteMany();
  await db.agentCapabilityEntry.deleteMany();
  await db.webhook.deleteMany();
  // The bindings go before the principals and the projects they name, so a second run leaves no
  // orphan binding behind.
  await db.roleBinding.deleteMany();
  await db.project.deleteMany();
  await db.agent.deleteMany();
  await db.user.deleteMany();
}

/**
 * Seeds the e2e database: an admin user, the fleet project and its repo.
 *
 * Idempotent: the wipe runs first, so calling it twice leaves the same rows as calling it once.
 */
export async function seedE2e(db: PrismaClient): Promise<void> {
  await wipe(db);

  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);

  const admin = await db.user.create({
    data: {
      email: ADMIN_EMAIL,
      name: 'E2E Admin',
      passwordHash,
    },
  });
  const principal = { type: 'USER', id: admin.id } as const;
  // The baseline production writes on creation, the global admin binding the legacy
  // `User { role: 'ADMIN' }` row stood for (its mirror keeps `User.role` at `ADMIN`), and the
  // project admin binding the legacy membership row in the fleet project stood for.
  await grantBaseline(db, principal);
  await grantRole(db, principal, 'admin', null);

  // Fleet slice 4c (D138): registering a repo needs a live forge (GitHub App or GitLab token),
  // which e2e has not got, so the fleet project and its repo are seeded directly.
  const fleetProject = await db.project.create({
    data: { name: 'E2E Fleet', slug: 'fleet-e2e', key: 'FLTE' },
  });
  await grantRole(db, principal, 'project-admin', fleetProject.id);
  await db.fleetRepo.create({
    data: {
      projectId: fleetProject.id, provider: 'github', owner: 'acme', name: 'e2e-app', defaultBranch: 'main',
      githubInstallationId: BigInt(1), createdById: admin.id,
    },
  });
}
