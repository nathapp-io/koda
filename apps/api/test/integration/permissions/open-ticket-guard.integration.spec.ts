import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Permissions P1 US-002 — the open-ticket guard on `DELETE /role-bindings/:id`, and the query behind it,
 * over real Postgres (AC-1 .. AC-6, AC-9, AC-10, AC-12).
 *
 * Every case builds its own project, agent and tickets, so the file is order-independent and no case
 * reads a row an earlier one wrote. Tickets are written directly (a ticket route would allocate numbers
 * through the workflow, which this story does not touch); the agent's baseline binding is granted
 * through `grantBaseline` like every other fixture.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/permissions/open-ticket-guard.integration.spec.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import * as bcrypt from 'bcrypt';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { TicketStatus } from '../../../src/common/enums';
import { MembershipService } from '../../../src/permissions/membership.service';
import { countOpenAgentTickets } from '../../../src/permissions/open-agent-tickets.queries';
import { grantBaseline, grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { expectGuardActive, fixtureDb } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

/** Booting `AppModule` runs the system-role seeder, so the first hook needs a generous budget. */
const BOOT_TIMEOUT_MS = 60_000;

/** `projectAgents.hasOpenTickets.409` as the i18n loader reads it: the sentence with `{count}`/`{refs}`. */
const OPEN_TICKETS = (
  JSON.parse(readFileSync(join(__dirname, '../../../src/i18n/en/projectAgents.json'), 'utf8')) as Record<
    string,
    Record<string, string>
  >
)['hasOpenTickets']?.['409'] as string;

describeIntegration('the open-ticket guard on binding removal (US-002)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let membership: MembershipService;
  let passwordHash: string;
  let sequence = 0;
  const tokens = new Map<string, string>();

  const newProject = async (): Promise<{ id: string; key: string }> => {
    const n = (sequence += 1);
    return db.project.create({ data: { name: `Open ${n}`, slug: `open-${n}`, key: `OK${n}` } });
  };

  const newUser = async () => {
    const n = (sequence += 1);
    const user = await db.user.create({
      data: { email: `open-${n}@koda.test`, name: `Open ${n}`, passwordHash },
    });
    await grantBaseline(db, { type: 'USER', id: user.id });
    return user;
  };

  const newAgent = async () => {
    const n = (sequence += 1);
    const agent = await db.agent.create({
      data: { name: `open-agent-${n}`, slug: `open-agent-${n}`, apiKeyHash: `open-hash-${n}` },
    });
    await grantBaseline(db, { type: 'AGENT', id: agent.id });
    return agent;
  };

  /** The user's access token, minted once per user and after every grant it holds. */
  const tokenFor = async (user: { id: string; email: string }): Promise<string> => {
    const cached = tokens.get(user.id);
    if (cached) return cached;
    resetThrottle(app);
    const token = await loginToken(server, user.email);
    tokens.set(user.id, token);
    return token;
  };

  /** Binds a seeded role to a principal; the grant is written under the cache, so the cache is dropped. */
  const grant = async (
    principal: { type: 'USER' | 'AGENT'; id: string },
    roleKey: string,
    projectId: string | null,
  ): Promise<{ id: string }> => {
    const binding = await grantRole(db, principal, roleKey, projectId);
    await membership.invalidatePermissions();
    return binding;
  };

  /** A user holding the global `admin` binding: every project key, plus `role.binding.global`. */
  const globalAdmin = async (): Promise<{ token: string; id: string }> => {
    const user = await newUser();
    await grant({ type: 'USER', id: user.id }, 'admin', null);
    return { token: await tokenFor(user), id: user.id };
  };

  /** One project ticket assigned to the agent. `createdAt` orders the refs the guard reports. */
  const newTicket = async (options: {
    projectId: string;
    agentId: string;
    number: number;
    status?: string;
    createdAt: Date;
    deletedAt?: Date | null;
  }): Promise<void> => {
    await db.ticket.create({
      data: {
        projectId: options.projectId,
        number: options.number,
        type: 'TASK',
        title: `Ticket ${options.number}`,
        status: options.status ?? TicketStatus.CREATED,
        assignedToAgentId: options.agentId,
        createdAt: options.createdAt,
        deletedAt: options.deletedAt ?? null,
      },
    });
  };

  const deleteBinding = (token: string, id: string) =>
    request(server).delete(`/api/role-bindings/${id}`).set({ Authorization: `Bearer ${token}` });

  const expectOpenTicketsRefusal = (res: request.Response, count: number, refs: string[]): void => {
    expect(res.status).toBe(409);
    expect(res.body.ret).toBe(409);
    expect(res.body).not.toHaveProperty('data');
    expect(res.body.message).toBe(
      OPEN_TICKETS.replace('{count}', String(count)).replace('{refs}', refs.join(', ')),
    );
  };

  const bindingExists = async (id: string): Promise<boolean> =>
    (await db.roleBinding.findUnique({ where: { id } })) !== null;

  beforeAll(async () => {
    await resetDb();
    passwordHash = await bcrypt.hash(TEST_PASSWORD, 4);
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    server = app.getHttpServer();
    db = fixtureDb(app);
    membership = app.get(MembershipService);
  }, BOOT_TIMEOUT_MS);

  beforeEach(() => {
    resetThrottle(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('AC-1: deleting an agent\'s only binding in P while it holds an open ticket there answers 409', async () => {
    const project = await newProject();
    const agent = await newAgent();
    const binding = await grant({ type: 'AGENT', id: agent.id }, 'viewer', project.id);
    await newTicket({ projectId: project.id, agentId: agent.id, number: 1, createdAt: new Date('2026-01-01T00:00:00Z') });
    const admin = await globalAdmin();

    const res = await deleteBinding(admin.token, binding.id);

    expectOpenTicketsRefusal(res, 1, [`${project.key}-1`]);
  });

  it('AC-2: after that refused DELETE the agent\'s viewer binding in P is still there', async () => {
    const project = await newProject();
    const agent = await newAgent();
    const binding = await grant({ type: 'AGENT', id: agent.id }, 'viewer', project.id);
    await newTicket({ projectId: project.id, agentId: agent.id, number: 1, createdAt: new Date('2026-01-01T00:00:00Z') });
    const admin = await globalAdmin();

    await deleteBinding(admin.token, binding.id).expect(409);

    expect(await bindingExists(binding.id)).toBe(true);
    expect(
      await db.roleBinding.count({ where: { principalType: 'AGENT', principalId: agent.id, projectId: project.id } }),
    ).toBe(1);
  });

  it('AC-3: deleting one of two agent bindings in P answers 204 while an open ticket remains', async () => {
    const project = await newProject();
    const agent = await newAgent();
    await grant({ type: 'AGENT', id: agent.id }, 'viewer', project.id);
    const developer = await grant({ type: 'AGENT', id: agent.id }, 'developer', project.id);
    await newTicket({ projectId: project.id, agentId: agent.id, number: 1, createdAt: new Date('2026-01-01T00:00:00Z') });
    const admin = await globalAdmin();

    await deleteBinding(admin.token, developer.id).expect(204);

    expect(await bindingExists(developer.id)).toBe(false);
  });

  it('AC-4: deleting the agent\'s only binding in P answers 204 when its only ticket there is CLOSED', async () => {
    const project = await newProject();
    const agent = await newAgent();
    const binding = await grant({ type: 'AGENT', id: agent.id }, 'viewer', project.id);
    await newTicket({
      projectId: project.id,
      agentId: agent.id,
      number: 1,
      status: TicketStatus.CLOSED,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const admin = await globalAdmin();

    await deleteBinding(admin.token, binding.id).expect(204);

    expect(await bindingExists(binding.id)).toBe(false);
  });

  it('AC-5: deleting the agent\'s only binding in P answers 204 when its only open ticket is in P2', async () => {
    const project = await newProject();
    const other = await newProject();
    const agent = await newAgent();
    const binding = await grant({ type: 'AGENT', id: agent.id }, 'viewer', project.id);
    await newTicket({ projectId: other.id, agentId: agent.id, number: 1, createdAt: new Date('2026-01-01T00:00:00Z') });
    const admin = await globalAdmin();

    await deleteBinding(admin.token, binding.id).expect(204);

    expect(await bindingExists(binding.id)).toBe(false);
  });

  it('AC-6: a projectId-null binding does not allow the removal while a ticket is open in P', async () => {
    const project = await newProject();
    const agent = await newAgent();
    await grant({ type: 'AGENT', id: agent.id }, 'viewer', null);
    const binding = await grant({ type: 'AGENT', id: agent.id }, 'viewer', project.id);
    await newTicket({ projectId: project.id, agentId: agent.id, number: 1, createdAt: new Date('2026-01-01T00:00:00Z') });
    const admin = await globalAdmin();

    const res = await deleteBinding(admin.token, binding.id);

    expectOpenTicketsRefusal(res, 1, [`${project.key}-1`]);
    expect(await bindingExists(binding.id)).toBe(true);
  });

  it('AC-9: countOpenAgentTickets counts the open tickets of the agent in the project', async () => {
    const project = await newProject();
    const agent = await newAgent();
    const base = new Date('2026-02-01T00:00:00Z');
    await newTicket({ projectId: project.id, agentId: agent.id, number: 1, createdAt: base });
    await newTicket({
      projectId: project.id,
      agentId: agent.id,
      number: 2,
      createdAt: new Date(base.getTime() + 1000),
    });
    await newTicket({
      projectId: project.id,
      agentId: agent.id,
      number: 3,
      status: TicketStatus.CLOSED,
      createdAt: new Date(base.getTime() + 2000),
    });
    await newTicket({
      projectId: project.id,
      agentId: agent.id,
      number: 4,
      createdAt: new Date(base.getTime() + 3000),
      deletedAt: new Date(base.getTime() + 4000),
    });

    const open = await countOpenAgentTickets(db, agent.id, project.id);

    expect(open.count).toBe(2);
  });

  it('AC-10: the refs are the oldest open tickets, each <project key>-<number>', async () => {
    const project = await newProject();
    const agent = await newAgent();
    const base = new Date('2026-03-01T00:00:00Z');
    // Inserted newest first, so only `createdAt` ordering can produce the asserted list.
    await newTicket({ projectId: project.id, agentId: agent.id, number: 1, createdAt: new Date(base.getTime() + 1000) });
    await newTicket({ projectId: project.id, agentId: agent.id, number: 2, createdAt: base });
    await newTicket({
      projectId: project.id,
      agentId: agent.id,
      number: 3,
      status: TicketStatus.REJECTED,
      createdAt: new Date(base.getTime() + 2000),
    });

    const open = await countOpenAgentTickets(db, agent.id, project.id);

    expect(open).toEqual({ count: 2, refs: [`${project.key}-2`, `${project.key}-1`] });
  });

  it('AC-12: the refusal carries the count and every ref, even for a caller with global authority', async () => {
    const project = await newProject();
    const agent = await newAgent();
    const binding = await grant({ type: 'AGENT', id: agent.id }, 'viewer', project.id);
    const base = new Date('2026-05-01T00:00:00Z');
    await newTicket({ projectId: project.id, agentId: agent.id, number: 1, createdAt: base });
    await newTicket({ projectId: project.id, agentId: agent.id, number: 2, createdAt: new Date(base.getTime() + 1000) });
    const admin = await globalAdmin();
    const open = await countOpenAgentTickets(db, agent.id, project.id);

    const res = await deleteBinding(admin.token, binding.id);

    expectOpenTicketsRefusal(res, open.count, open.refs);
    expect(open).toEqual({
      count: 2,
      refs: [`${project.key}-1`, `${project.key}-2`],
    });
    expect(await bindingExists(binding.id)).toBe(true);
  });
});
