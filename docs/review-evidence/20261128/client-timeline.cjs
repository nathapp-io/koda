// Run with node path/to/client-timeline.cjs after installing repo dependencies.
const assert = require('node:assert/strict');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { registerHooks } = require('node:module');
const root = resolve(__dirname, '../../..');
process.env.TSX_TSCONFIG_PATH = resolve(root, 'apps/api/tsconfig.json');
require('tsx/cjs');
const { TimelineController } = require(resolve(root, 'apps/api/src/memory/timeline.controller.ts'));
const { TimelineService } = require(resolve(root, 'apps/api/src/memory/timeline.service.ts'));
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '~/lib/api-path') {
    return { shortCircuit: true, url: pathToFileURL(resolve(root, 'apps/web/lib/api-path.ts')).href };
  }
  return next(specifier, context);
} });
const { useTimelineEvents } = require(resolve(root, 'apps/web/composables/useTimelineEvents.ts'));
hooks.deregister();

// Local Nov 28 begins at 16:00 UTC on Nov 27 in Malaysia.
const rows = [
  ['local-start', '2026-11-27T16:00:00.000Z'],
  ['utc-start', '2026-11-28T00:00:00.000Z'],
  ['utc-noon', '2026-11-28T12:00:00.000Z'],
  ['local-end', '2026-11-28T15:59:59.999Z'],
  ['following-local-day', '2026-11-28T16:00:00.000Z'],
].map(([id, time]) => ({ id, createdAt: new Date(time), actorId: 'u', action: 'sample' }));
const service = new TimelineService({
  findTicketEvents: async where => rows.filter(row => {
    const bounds = where.createdAt;
    return (!bounds?.gte || row.createdAt >= bounds.gte) && (!bounds?.lte || row.createdAt <= bounds.lte);
  }),
  findAgentEvents: async () => [], findDecisionEvents: async () => [],
  findEventLabels: async () => ({ names: new Map(), tickets: new Map() }),
});
const controller = new TimelineController(service, { findProjectIdBySlug: async () => 'p' });
const observed = [];
global.useApi = () => ({ $api: { get: async (path, { query }) => {
  assert.equal(path, '/projects/sample/timeline');
  observed.push(query);
  const response = await controller.getTimeline('sample', undefined, undefined, undefined, query.from, query.to);
  return response.data;
} } });

async function check() {
  const timeline = useTimelineEvents('sample');
  await timeline.applyFilters();
  assert.equal(timeline.events.value.length, 5);
  timeline.fromFilter.value = timeline.toFilter.value = '2026-11-28';
  await timeline.applyFilters();
  assert.deepEqual(observed.at(-1), { from: '2026-11-28', to: '2026-11-28' });
  assert.deepEqual(timeline.events.value.map(row => row.id), ['utc-start']);
  timeline.fromFilter.value = '2026-11-28T00:00:00+08:00';
  timeline.toFilter.value = '2026-11-28T23:59:59.999+08:00';
  await timeline.applyFilters();
  assert.deepEqual(timeline.events.value.map(row => row.id), ['local-end', 'utc-noon', 'utc-start', 'local-start']);
  console.log('#13: actual composable/controller/service return 5 events unfiltered, 1 at UTC midnight with date controls, 4 on the selected Malaysia day with explicit bounds.');
}
check().catch(error => { console.error(error); process.exitCode = 1; });
