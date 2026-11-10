import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Schema = { properties?: Record<string, { $ref?: string; allOf?: Array<{ $ref?: string }> }>; enum?: string[] };
type OpenApi = { components: { schemas: Record<string, Schema> } };

const spec = JSON.parse(readFileSync(join(__dirname, '../../../../../openapi.json'), 'utf8')) as OpenApi;

describe('thread queued-turn OpenAPI contract', () => {
  it('AC-11: publishes queuedTurn and its exact DTO fields', () => {
    const thread = spec.components.schemas['ThreadDetailDto'];
    const queued = spec.components.schemas['QueuedTurnDto'];
    expect(thread?.properties?.['queuedTurn']?.allOf?.[0]?.$ref).toBe('#/components/schemas/QueuedTurnDto');
    expect(Object.keys(queued?.properties ?? {}).sort()).toEqual(['jobId', 'queuedAt', 'reasons', 'verdict']);
    expect(queued?.enum).toBeUndefined();
    expect(spec.components.schemas['QueuedTurnReasonDto']?.properties).toEqual(expect.objectContaining({ runnerName: expect.any(Object), reason: expect.any(Object) }));
  });
});
