// Fixture transport for client-review.cjs. No requests leave the child process.
const fs = require('node:fs');
const os = require('node:os');
const { join } = require('node:path');
const root = join(__dirname, '../../..');
os.homedir = () => process.env.KODA_TEST_HOME;
require('node:module').syncBuiltinESMExports();

function api(module) {
  return require(join(root, 'apps/api/src', module + '.ts'));
}

async function tickets(query) {
  const { TicketsController } = api('tickets/tickets.controller');
  const { TicketsService } = api('tickets/tickets.service');
  const { PrismaTicketsRepository } = api('tickets/prisma-tickets.repository');
  const makeRow = (number, assignedToAgentId, assignedToUserId) => ({
    number, id: String(number), assignedToAgentId, assignedToUserId, projectId: 'p', deletedAt: null,
  });
  const rows = Array.from({ length: Number(process.env.REVIEW_COUNT) }, (_, i) => makeRow(i + 1, 'agent-id', null));
  rows.push(makeRow(200, null, 'user-id'));
  function matching(where) {
    return rows.filter(row => Object.entries(where).every(([key, value]) => row[key] === value));
  }
  const repo = new PrismaTicketsRepository({ client: {
    project: { findUnique: async () => ({ id: 'p', key: 'TEST', slug: 'sample' }) },
    ticket: {
      count: async ({ where }) => matching(where).length,
      findMany: async ({ where, skip, take }) => matching(where).slice(skip, skip + take),
    },
  } });
  return new TicketsController(new TicketsService(repo)).findAll('sample', query, { actorType: 'agent', id: 'agent-id' });
}

globalThis.fetch = async request => {
  const url = new URL(request.url);
  if (url.origin !== 'http://fixture.invalid') throw new Error('Unexpected address');
  fs.appendFileSync(process.env.REVIEW_REQUESTS, JSON.stringify([request.method, url.pathname, Object.fromEntries(url.searchParams)]) + '\n');
  if (request.method === 'GET' && url.pathname === '/api/projects/sample/tickets') {
    return Response.json(await tickets(Object.fromEntries(url.searchParams)));
  }
  if (request.method === 'DELETE' && url.pathname === '/api/projects/sample/labels/label-id') {
    return new Response(null, { status: 204 });
  }
  if (request.method === 'POST' && url.pathname === '/api/projects/sample/kb/evaluate/retrieval') {
    const score = Number(process.env.REVIEW_SCORE);
    const data = { precisionAt5_avg: score, precisionAt5_p50: score, precisionAt5_p95: score, totalQueries: 1, results: [] };
    return Response.json({ ret: 0, data });
  }
  throw new Error('Unexpected route ' + url.pathname);
};
