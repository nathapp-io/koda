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
import { JwtRefreshStrategyProvider } from '@nathapp/nestjs-auth';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../src/generated/prisma/client';
import { grantBaseline, grantRole } from '../src/permissions/test-helpers/permission-fixtures';
import { PASSWORD_RESET_TTL_MS } from '../src/auth/password-reset/password-reset.constants';
import { generatePasswordResetToken } from '../src/auth/password-reset/password-reset-token';
import { refreshClientOf } from '../src/auth/sessions/refresh-client';

const ADMIN_EMAIL = 'admin@koda-e2e.test';
const ADMIN_PASSWORD = 'E2ePassword1!';

/**
 * The accounts the password journeys use (koda #466).
 *
 * Never the admin: every e2e spec logs in as `E2E_ADMIN`, and the e2e database is reset only at the
 * start of a run, so a journey that changed the admin's password would break every spec that runs
 * after it.
 *
 * One account per journey, because a confirmation spends its token and discards the account's other
 * outstanding links — with one shared account the journeys would spoil each other, and a spec that
 * runs alone (a CI retry, a `--grep`) would see a different answer than the suite does.
 */
const JOURNEY_PASSWORD = 'E2ePassword1!';
const JOURNEY_ACCOUNTS = {
  valid: 'password-valid@koda-e2e.test',
  replayable: 'password-replay@koda-e2e.test',
  expired: 'password-expired@koda-e2e.test',
  weak: 'password-weak@koda-e2e.test',
  session: 'password-session@koda-e2e.test',
} as const;

/** The User-Agent the seeded refresh token is bound to; the browser journey presents the same one. */
const JOURNEY_USER_AGENT = 'KodaE2E-UA/1.0';

/**
 * What the web e2e needs from the seed. The runner writes it to `$E2E_AUTH_FIXTURE_FILE`.
 *
 * The things a browser journey cannot build for itself:
 *
 * - a reset token: `POST /auth/password-reset` writes none while email is unconfigured (the e2e API
 *   has no SMTP), and only the sha256 of a token is stored, so the raw value exists only in a link;
 * - an expired reset token, for the dead-link path;
 * - a refresh token that was already used, bound to a known User-Agent: presenting it again is the
 *   lost-response recovery — the only path on which the API compares the User-Agent.
 */
export interface E2eAuthFixture {
  /** One account per reset token, so a journey that spends a token cannot spoil another's. */
  accounts: Record<'valid' | 'replayable' | 'expired' | 'weak', E2eJourneyAccount>;
  /** The User-Agent the seeded refresh token is bound to. */
  userAgent: string;
  /** A refresh token that was already used once. */
  refreshToken: string;
}

/** One journey account: the credentials it signs in with and the reset token it presents. */
export interface E2eJourneyAccount {
  email: string;
  password: string;
  resetToken: string;
}

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
 * Seeds the e2e database: an admin user, the fleet project and its repo, and the auth fixtures the
 * password journeys need.
 *
 * Idempotent: the wipe runs first, so calling it twice leaves the same rows as calling it once.
 */
export async function seedE2e(db: PrismaClient): Promise<E2eAuthFixture> {
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

  return await seedAuthJourney(db);
}

/**
 * The auth fixtures the password journeys need (koda #466).
 *
 * The accounts carry no role binding: the journeys are about the account itself, and every route
 * they touch is either public or `own`.
 */
async function seedAuthJourney(db: PrismaClient): Promise<E2eAuthFixture> {
  const now = new Date();
  // One hash for every journey account: they share the password, and bcrypt at cost 12 is the
  // seed's slowest step.
  const passwordHash = await bcrypt.hash(JOURNEY_PASSWORD, 12);

  const accounts = {} as Record<'valid' | 'replayable' | 'expired' | 'weak', E2eJourneyAccount>;
  for (const key of ['valid', 'replayable', 'expired', 'weak'] as const) {
    const user = await db.user.create({
      data: { email: JOURNEY_ACCOUNTS[key], name: 'Password Journey', passwordHash },
    });
    // Only the sha256 of a token is stored, so the raw values reach the browser journey through the
    // fixture file.
    const token = generatePasswordResetToken();
    await db.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: token.hash,
        expiresAt: key === 'expired'
          ? new Date(now.getTime() - 60_000)
          : new Date(now.getTime() + PASSWORD_RESET_TTL_MS),
      },
    });
    accounts[key] = { email: JOURNEY_ACCOUNTS[key], password: JOURNEY_PASSWORD, resetToken: token.raw };
  }

  // A refresh token that was already used, bound to a known User-Agent. Presenting it again is the
  // lost-response recovery — the only path on which the API compares the User-Agent, because the
  // reuse grace short-circuits every presentation inside its window. Its `usedAt` is backdated past
  // that grace, so the recovery fires at once instead of after a wait.
  const sessionUser = await db.user.create({
    data: { email: JOURNEY_ACCOUNTS.session, name: 'Password Journey Session', passwordHash },
  });
  const sessionId = randomUUID();
  const tokenId = randomUUID();
  await db.authSession.create({
    data: { id: sessionId, userId: sessionUser.id, expiresAt: new Date(now.getTime() + 60 * 60_000) },
  });
  await db.refreshToken.create({
    data: {
      id: tokenId,
      sessionId,
      usedAt: new Date(now.getTime() - 2 * 60_000),
      usedUaHash: refreshClientOf(JOURNEY_USER_AGENT, undefined).uaHash,
    },
  });

  return {
    accounts,
    userAgent: JOURNEY_USER_AGENT,
    refreshToken: signRefreshToken(sessionUser.id, sessionId, tokenId),
  };
}

/**
 * A refresh JWT for the seeded session, signed the way `AuthService.generateRefreshToken` signs one.
 *
 * The library's own provider does the signing, so the `typ: "refresh"` claim and the expiry come
 * from the same place the API's tokens come from — nothing about the claim shape is restated here.
 */
function signRefreshToken(userId: string, sessionId: string, tokenId: string): string {
  const secret = process.env['JWT_REFRESH_SECRET'];
  if (!secret) {
    throw new Error('JWT_REFRESH_SECRET is required to seed the e2e refresh token');
  }
  const provider = new JwtRefreshStrategyProvider({
    secret,
    signOption: { expiresIn: process.env['JWT_REFRESH_EXPIRES_IN'] ?? '7d' },
  });
  return provider.sign({ sub: userId, tokenVersion: 0, sid: sessionId, jti: tokenId });
}
