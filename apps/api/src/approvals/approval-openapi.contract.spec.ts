import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type OpenApiDocument = {
  paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
};

const openapi = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../openapi.json'), 'utf8'),
) as OpenApiDocument;

const gatedOperations = [
  ['post', '/api/roles'],
  ['patch', '/api/roles/{id}'],
  ['delete', '/api/roles/{id}'],
  ['post', '/api/role-bindings'],
  ['delete', '/api/role-bindings/{id}'],
  ['post', '/api/approval-policies'],
  ['patch', '/api/approval-policies/{id}'],
  ['delete', '/api/approval-policies/{id}'],
  ['post', '/api/projects/{slug}/approval-policies'],
  ['patch', '/api/projects/{slug}/approval-policies/{id}'],
  ['delete', '/api/projects/{slug}/approval-policies/{id}'],
  ['post', '/api/approvals/{id}/decisions'],
] as const;

const reindexOperation = ['post', '/api/projects/{slug}/knowledge/repos/{repoId}/reindex'] as const;

function operationsWith202(): string[] {
  return Object.entries(openapi.paths).flatMap(([path, methods]) =>
    Object.entries(methods)
      .filter(([, operation]) => operation.responses?.['202'] !== undefined)
      .map(([method]) => `${method.toLowerCase()} ${path}`),
  ).sort();
}

describe('OpenAPI pending response contract', () => {
  it('AC-1: POST /api/roles has a 202 response', () => {
    expect(openapi.paths['/api/roles']?.post?.responses).toHaveProperty('202');
  });

  it('AC-2: DELETE /api/role-bindings/{id} has a 202 response', () => {
    expect(openapi.paths['/api/role-bindings/{id}']?.delete?.responses).toHaveProperty('202');
  });

  it('AC-3: POST /api/approvals/{id}/decisions has a 202 response', () => {
    expect(openapi.paths['/api/approvals/{id}/decisions']?.post?.responses).toHaveProperty('202');
  });

  it('AC-4: 202 responses exist on exactly the twelve gated operations and existing reindex operation', () => {
    const expected = [...gatedOperations, reindexOperation].map(([method, path]) => `${method} ${path}`).sort();
    expect(operationsWith202()).toEqual(expected);
  });
});
