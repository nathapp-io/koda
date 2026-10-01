import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Fleet slice 4a contract (overview D116-D120): the committed openapi.json must carry what the CLI
 * and web build on. Regenerate with `bun run api:export-spec` from the repo root.
 */
interface Operation { parameters?: Array<{ name: string; in: string; required?: boolean }> }
interface Spec {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, { properties?: Record<string, unknown>; required?: string[] }> };
}

const spec = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', '..', 'openapi.json'), 'utf-8')) as Spec;

describe('fleet OpenAPI contract', () => {
  it('declares the slug path param on every project-scoped fleet operation (D120)', () => {
    const scoped = Object.entries(spec.paths).filter(([path]) => path.startsWith('/api/projects/{slug}/fleet'));
    expect(scoped.length).toBeGreaterThanOrEqual(7);
    for (const [path, methods] of scoped) {
      for (const [method, op] of Object.entries(methods)) {
        const slug = (op.parameters ?? []).find((p) => p.name === 'slug' && p.in === 'path');
        expect({ path, method, slug: Boolean(slug?.required) }).toEqual({ path, method, slug: true });
      }
    }
  });

  it('exposes the runner boot fields and online state (#158, D116, D117)', () => {
    expect(Object.keys(spec.components.schemas['RunnerDto']?.properties ?? {})).toEqual(expect.arrayContaining(['bootId', 'bootedAt', 'online']));
  });

  it('exposes project runner summaries and the repo check (D118, D119)', () => {
    expect(spec.paths['/api/projects/{slug}/fleet/runners']?.['get']).toBeDefined();
    expect(spec.paths['/api/fleet/repos/{id}/check']?.['post']).toBeDefined();
    expect(Object.keys(spec.components.schemas['RunnerSummaryDto']?.properties ?? {}).sort())
      .toEqual(['arch', 'enabled', 'id', 'labels', 'name', 'online', 'os', 'profiles']);
    expect(Object.keys(spec.components.schemas['RepoCheckResultDto']?.properties ?? {}).sort())
      .toEqual(['checkedAt', 'reachable', 'reason', 'repoId']);
  });
});
