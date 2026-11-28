// Build apps/api, then run from the repository root with node docs/review-evidence/20261128/api-tickets.mjs
import assert from 'node:assert/strict';
import { PrismaTicketsRepository } from '../../../apps/api/dist/tickets/prisma-tickets.repository.js';
import { TicketsService } from '../../../apps/api/dist/tickets/tickets.service.js';
import { TicketTransitionsService } from '../../../apps/api/dist/tickets/state-machine/ticket-transitions.service.js';
import { TicketResponseDto } from '../../../apps/api/dist/tickets/dto/ticket-response.dto.js';
import { TicketRouteCommands } from '../../../apps/api/dist/tickets/ticket-route.commands.js';
import { TicketsController } from '../../../apps/api/dist/tickets/tickets.controller.js';
import { ApprovalCommandRegistry } from '../../../apps/api/dist/approvals/approval-command.registry.js';
import { VcsPrSyncService } from '../../../apps/api/dist/vcs/vcs-pr-sync.service.js';

const project = { id: 'p', key: 'EX', slug: 'example', gitRemoteUrl: null };
const label = { id: 'l', projectId: project.id, name: 'example', color: null };
const row = {
  id: 't', projectId: project.id, number: 7, title: 'example', status: 'CREATED',
  type: 'BUG', priority: 'MEDIUM', labels: [{ label }], links: [], deletedAt: null,
};
const prisma = { client: {
  project: { findUnique: async () => project },
  ticket: {
    findUnique: async () => structuredClone(row),
    update: async ({data}) => structuredClone(Object.assign(row, data)),
    updateMany: async ({ where, data }) => {
      assert.equal(row.status, where.status);
      Object.assign(row, data);
      return { count: 1 };
    },
  },
  ticketActivity: { create: async ({ data }) => ({ id: 'activity', ...data }) },
} };
const repo = new PrismaTicketsRepository(prisma);
const tx = { run: async fn => fn() };
const permissions = { can: async () => ({allowed: true}) };
const audit = { record: async () => {}, audited: async fn => fn() };
const transitions = new TicketTransitionsService(repo, tx, permissions, audit);
const events = {create: async data => ({id:'e', createdAt:new Date(), ...data})};
const service = new TicketsService(repo, tx, events, {record:async () => {}}, transitions, permissions, audit);
const principal = { actorType: 'user', id: 'u' };
const commands = new ApprovalCommandRegistry();
new TicketRouteCommands(commands, service, transitions, { forContext: async () => principal }, permissions).onModuleInit();
const immediate = {
  async run({key, variant, input}) {
    const command = commands.get(key, variant);
    return {status: 'executed', result: await command.execute(command.parse(input))};
  },
};
const controller = new TicketsController(service, transitions, immediate);
const asJson = value => JSON.parse(JSON.stringify(value));
const read = asJson(await controller.findByRef('example', 'EX-7', principal, { project })).data;
const patch = asJson(await controller.update('example', 'EX-7', { status: 'IN_PROGRESS' }, principal, { project })).data;
row.status = 'CREATED';
const start = asJson(await controller.start('example', 'EX-7', principal, { project })).data;
const control = asJson(TicketResponseDto.from(row, project.key));
assert.equal(read.ref, 'EX-7');
assert.equal(control.labels[0].projectId, 'p');
assert.equal(read.labels[0].name, 'example');
assert.equal('projectId' in read.labels[0], false);
for (const result of [patch, start]) {
  assert.equal(result.status, 'IN_PROGRESS');
  assert.equal('ref' in result, false);
  assert.equal(result.labels[0].label.id, 'l');
}
console.log('9/17', JSON.stringify({read: [read.ref,read.labels], patch: [patch.ref,patch.labels], start: [start.ref,start.labels], control:control.labels}));

async function applyFetchedMerge(snapshotStatus, liveStatus) {
  const state = { link: 'open', ticket: liveStatus, transitionAttempts: 0 };
  const vcs = new VcsPrSyncService({
    updateTicketLinkWithPrState: async (_id, next) => {
      const previousState = state.link;
      state.link = next;
      return { result:'updated', previousState };
    },
    applyMergedPrTransition: async () => {
      state.transitionAttempts++;
      if (state.ticket !== 'IN_PROGRESS') return false;
      state.ticket = 'VERIFY_FIX';
      return true;
    },
  }, audit);
  const item = {
    kind: 'status', link: {id:'l', ticketId:'t', prState:'open', ticket:{id:'t', projectId:'p', status:snapshotStatus}},
    status:{number:1, state:'closed', merged:true, url:'https://example.invalid/pr/1'},
  };
  const result = await vcs.applyPrStatuses(project, {}, '', [item], 'system.vcs.pr-merge-transition', {isolate:false});
  assert.equal(result.updated, 1);
  return state;
}
const fresh = await applyFetchedMerge('IN_PROGRESS','IN_PROGRESS');
const stale = await applyFetchedMerge('VERIFIED','IN_PROGRESS');
assert.deepEqual(fresh, {link:'merged', ticket:'VERIFY_FIX', transitionAttempts:1});
assert.deepEqual(stale, {link:'merged', ticket:'IN_PROGRESS', transitionAttempts:0});
console.log('8', JSON.stringify({fresh, stale}));
