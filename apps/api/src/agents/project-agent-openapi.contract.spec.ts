import { readFileSync } from 'fs';
import { join } from 'path';

interface Spec {
  components: { schemas: Record<string, { properties?: Record<string, { type?: string }>; required?: string[] }> };
}
const spec = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', '..', 'openapi.json'), 'utf-8')) as Spec;

describe('project agent OpenAPI contract', () => {
  it('US-001 AC-3: declares agent id as a required string', () => {
    const schema = spec.components.schemas.ProjectAgentDto;
    expect(schema.properties?.id?.type).toBe('string');
    expect(schema.required).toContain('id');
  });
});
