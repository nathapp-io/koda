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
  ['post', '/api/fleet/budgets'],
  ['patch', '/api/fleet/budgets/{id}'],
  ['delete', '/api/fleet/budgets/{id}'],
  ['post', '/api/fleet/budgets/{id}/resume'],
  ['post', '/api/projects/{slug}/fleet/budgets'],
  ['patch', '/api/projects/{slug}/fleet/budgets/{id}'],
  ['delete', '/api/projects/{slug}/fleet/budgets/{id}'],
  ['post', '/api/projects/{slug}/fleet/budgets/{id}/resume'],
  ['post', '/api/projects/{slug}/fleet/jobs'],
  ['post', '/api/projects/{slug}/fleet/jobs/{id}/cancel'],
  ['post', '/api/projects/{slug}/fleet/jobs/{id}/requeue'],
  ['delete', '/api/projects/{slug}/tickets/{ref}/fleet-jobs/{jobId}'],
  ['post', '/api/fleet/repos'],
  ['delete', '/api/fleet/repos/{id}'],
  ['post', '/api/fleet/repos/{id}/check'],
  ['patch', '/api/fleet/runners/{id}'],
  ['delete', '/api/fleet/runners/{id}'],
  ['delete', '/api/fleet/analytics'],
  ['delete', '/api/projects/{slug}/fleet/schedules/{id}'],
  ['post', '/api/projects/{slug}/fleet/schedules'],
  ['patch', '/api/projects/{slug}/fleet/schedules/{id}'],
  ['post', '/api/projects/{slug}/fleet/schedules/{id}/enable'],
  ['post', '/api/projects/{slug}/fleet/schedules/{id}/disable'],
  ['post', '/api/projects/{slug}/fleet/repos/{repoId}/config-edits'],
  ['post', '/api/projects/{slug}/fleet/repos/{repoId}/config-edits/regenerate'],
  ['post', '/api/fleet/ingest/backfill'],
  ['post', '/api/fleet/ingest/jobs/{jobId}/rerun'],
  ['post', '/api/fleet/ingest/rerun-outdated'],
  ['put', '/api/projects/{slug}/knowledge/patterns'],
  ['post', '/api/projects/{slug}/knowledge/repos/{repoId}/reindex'],
  ['delete', '/api/comments/{id}'],
  ['delete', '/api/projects/{slug}/labels/{id}'],
  ['delete', '/api/projects/{slug}/tickets/{ref}'],
  ['delete', '/api/projects/{slug}/tickets/{ref}/labels/{labelId}'],
  ['delete', '/api/projects/{slug}/tickets/{ref}/links/{linkId}'],
  ['post', '/api/projects/{slug}/fleet/repos/{repoId}/drift-checks'],
  ['delete', '/api/projects/{slug}'],
  ['delete', '/api/projects/{slug}/kb/documents/{sourceId}'],
  ['post', '/api/projects/{slug}/kb/documents'],
  ['post', '/api/projects/{slug}/kb/import/graphify'],
  ['post', '/api/projects/{slug}/kb/optimize'],
  ['delete', '/api/agents/{slug}'],
  ['delete', '/api/admin/skills/sources/{id}'],
  ['post', '/api/admin/skills/sources'],
  ['post', '/api/admin/skills/sources/{id}/update'],
  ['delete', '/api/projects/{slug}/webhooks/{id}'],
  ['delete', '/api/webhooks/{id}'],
  ['delete', '/api/projects/{slug}/vcs'],
  ['post', '/api/projects/{slug}/vcs/test'],
  ['post', '/api/projects/{slug}/tickets'],
  ['patch', '/api/projects/{slug}/tickets/{ref}'],
  ['post', '/api/projects/{slug}/tickets/{ref}/assign'],
  ['post', '/api/projects/{slug}/tickets/{ref}/verify'],
  ['post', '/api/projects/{slug}/tickets/{ref}/start'],
  ['post', '/api/projects/{slug}/tickets/{ref}/fix'],
  ['post', '/api/projects/{slug}/tickets/{ref}/verify-fix'],
  ['post', '/api/projects/{slug}/tickets/{ref}/close'],
  ['post', '/api/projects/{slug}/tickets/{ref}/reject'],
  ['post', '/api/projects/{slug}/tickets/{ref}/comments'],
  ['patch', '/api/comments/{id}'],
  ['post', '/api/projects/{slug}/labels'],
  ['patch', '/api/projects/{slug}/labels/{id}'],
  ['post', '/api/projects/{slug}/tickets/{ref}/labels'],
  ['post', '/api/projects/{slug}/tickets/{ref}/links'],
  ['post', '/api/projects'],
  ['patch', '/api/projects/{slug}'],
  ['post', '/api/projects/{slug}/members'],
  ['delete', '/api/projects/{slug}/invites/{id}'],
  ['put', '/api/projects/{slug}/tickets/{ref}/watch'],
  ['delete', '/api/projects/{slug}/tickets/{ref}/watch'],
  ['patch', '/api/agents/{slug}'],
  ['patch', '/api/agents/{slug}/update-capabilities'],
  ['patch', '/api/projects/{slug}/agents/{agentSlug}'],
  ['patch', '/api/admin/users/{id}'],
  // JWT-only over REST, but still a gated command with a documented pending response.
  ['post', '/api/admin/outbox/{eventId}/retry'],
  ['put', '/api/projects/{slug}/skills/{skillId}'],
  ['delete', '/api/projects/{slug}/skills/{skillId}'],
  ['post', '/api/code-intel/index'],
  ['post', '/api/memory'],
  ['post', '/api/memory/decisions'],
  ['post', '/api/memory/extract'],
  ['post', '/api/projects/{slug}/vcs/sync-pr'],
  ['post', '/api/projects/{slug}/vcs/sync'],
  ['post', '/api/projects/{slug}/vcs/sync/{issueNumber}'],
] as const;

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

  it('AC-4 (US-010): DELETE /api/projects/{slug} has a 202 response', () => {
    expect(openapi.paths['/api/projects/{slug}']?.delete?.responses).toHaveProperty('202');
  });

  it('AC-5 (US-010): DELETE /api/fleet/budgets/{id} has a 202 response', () => {
    expect(openapi.paths['/api/fleet/budgets/{id}']?.delete?.responses).toHaveProperty('202');
  });

  it('AC-6 (US-010): DELETE /api/projects/{slug}/kb/documents/{sourceId} has a 202 response', () => {
    expect(openapi.paths['/api/projects/{slug}/kb/documents/{sourceId}']?.delete?.responses).toHaveProperty('202');
  });

  it('AC-7 (US-010): POST /api/fleet/enrollments remains ungated', () => {
    expect(openapi.paths['/api/fleet/enrollments']?.post?.responses).not.toHaveProperty('202');
  });

  it('AC-4: POST /api/projects/{slug}/tickets has a 202 response', () => {
    expect(openapi.paths['/api/projects/{slug}/tickets']?.post?.responses).toHaveProperty('202');
  });

  it('AC-5: POST /api/projects/{slug}/invites has no 202 response', () => {
    expect(openapi.paths['/api/projects/{slug}/invites']?.post?.responses).not.toHaveProperty('202');
  });

  it('AC-5: POST /api/memory has a 202 response', () => {
    expect(openapi.paths['/api/memory']?.post?.responses).toHaveProperty('202');
  });

  it('AC-6: secret agent creation has no 202 response', () => {
    expect(openapi.paths['/api/agents']?.post?.responses).not.toHaveProperty('202');
  });

  it('AC-7: POST knowledge-base search has no 202 response', () => {
    expect(openapi.paths['/api/projects/{slug}/kb/search']?.post?.responses).not.toHaveProperty('202');
  });

  it('AC-8: 202 responses exist on exactly the gated operations', () => {
    const expected = gatedOperations.map(([method, path]) => `${method} ${path}`).sort();
    expect(operationsWith202()).toEqual(expected);
  });
});
