import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { canRunDbTests } from '../../helpers/test-environment';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { fixtureDb } from '../../helpers/action-context';
import { seedFleetHttpAgent, seedFleetHttpWorld, rosterFleetAgent, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';

const describeDb = canRunDbTests() ? describe : describe.skip;
describeDb('agent pickup audit HTTP', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let world: FleetHttpWorld;
  let agent: { id: string; slug: string; apiKey: string };
  let fixtureSeq = 0;

  const auth = () => ({ Authorization: `Bearer ${agent.apiKey}` });
  const freshProject = async () => {
    const suffix = ++fixtureSeq;
    const project = await db.project.create({ data: { name: `pickup-${suffix}`, slug: `pickup-${suffix}`, key: `P${suffix}` } });
    await rosterFleetAgent(db, agent.id, project.id);
    return project;
  };
  const pickup = (slug: string) => request(app.getHttpServer()).get(`/api/agents/${agent.slug}/pickup`).query({ project: slug }).set(auth());
  const makeTicket = (projectId: string) => db.ticket.create({ data: {
    projectId, number: 1, title: `Pickup ${fixtureSeq}`, type: 'TASK', status: 'VERIFIED',
  } });
  const entriesFor = (projectId: string, resourceId: string) => db.auditEntry.findMany({ where: { key: 'agent.pickup', resourceId, projectId } });
  const agentEvents = (projectId: string) => db.agentEvent.findMany({ where: { agentId: agent.id, projectId, action: 'TICKET_SUGGESTED' } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), db);
    agent = await seedFleetHttpAgent(app.getHttpServer(), world.tokens.root);
    await rosterFleetAgent(db, agent.id, world.projectId);
  }, 60_000);
  beforeEach(() => resetThrottle(app));
  afterAll(async () => { await app?.close(); });

  it('AC-1: records the suggested ticket, project and agent attribution', async () => {
    const project = await freshProject();
    const ticket = await makeTicket(project.id);
    const result = data<{ ticket: { id: string; number: number } }>(await pickup(project.slug).expect(200));
    expect(result.ticket.id).toBe(ticket.id);
    expect(await entriesFor(project.id, ticket.id)).toEqual([expect.objectContaining({
      key: 'agent.pickup', resourceType: 'ticket', resourceId: ticket.id, projectId: project.id,
      actorType: 'AGENT', actorId: agent.id, summary: `suggested ${project.key}-${ticket.number} to ${agent.slug}`,
    })]);
  });

  it('AC-2: an empty pickup returns null and writes neither a suggestion event nor an audit entry', async () => {
    const project = await freshProject();
    const beforeEvents = await agentEvents(project.id);
    const response = await pickup(project.slug).expect(200);
    expect(data(response)).toBeNull();
    expect(await agentEvents(project.id)).toEqual(beforeEvents);
    expect(await db.auditEntry.findMany({ where: { key: 'agent.pickup', projectId: project.id } })).toEqual([]);
  });

  it('AC-3: each repeated suggestion creates a distinct entry for the same ticket', async () => {
    const project = await freshProject();
    const ticket = await makeTicket(project.id);
    for (let call = 0; call < 2; call++) {
      resetThrottle(app);
      const result = data<{ ticket: { id: string } }>(await pickup(project.slug).expect(200));
      expect(result.ticket.id).toBe(ticket.id);
    }
    expect(await entriesFor(project.id, ticket.id)).toEqual([
      expect.objectContaining({ key: 'agent.pickup', resourceId: ticket.id }),
      expect.objectContaining({ key: 'agent.pickup', resourceId: ticket.id }),
    ]);
    expect(await agentEvents(project.id)).toHaveLength(2);
  });
});
