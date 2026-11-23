import { readFileSync } from 'fs';
import { join } from 'path';

interface SchemaNode {
  type?: string;
  nullable?: boolean;
}
interface Spec {
  components: { schemas: Record<string, { properties?: Record<string, SchemaNode>; required?: string[] }> };
}

const spec = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', '..', 'openapi.json'), 'utf-8')) as Spec;

describe('home OpenAPI contract', () => {
  it('AC-12: documents HomeJobDto threadTitle as a required nullable string', () => {
    const schema = spec.components.schemas['HomeJobDto'];
    expect(schema?.required).toContain('threadTitle');
    expect(schema?.properties?.['threadTitle']).toMatchObject({ type: 'string', nullable: true });
  });
});
