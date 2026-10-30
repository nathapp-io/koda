import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type OpenApiOperation = {
  responses?: Record<string, unknown>;
  parameters?: { name?: string; in?: string }[];
};
type OpenApiDocument = {
  paths: Record<string, Record<string, OpenApiOperation>>;
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
  ['post', '/api/projects/{slug}/fleet/approvals/{id}/decide'],
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
  // `gate-secret` pilots (US-006, US-007): redeem routes, so their 202 releases a request that runs
  // nothing and carries the `X-Koda-Approval-Request` header.
  ['post', '/api/agents'],
  ['post', '/api/agents/{slug}/rotate-key'],
  ['post', '/api/admin/users'],
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
  ['post', '/api/projects/{slug}/threads'],
  ['patch', '/api/projects/{slug}/threads/{id}'],
  ['post', '/api/projects/{slug}/threads/{id}/plan'],
  ['post', '/api/projects/{slug}/threads/{id}/run'],
  ['post', '/api/projects/{slug}/threads/{id}/stop'],
  ['post', '/api/projects/{slug}/threads/{id}/end-session'],
  ['post', '/api/projects/{slug}/threads/{id}/answer'],
  ['post', '/api/projects/{slug}/threads/{id}/archive'],
  ['post', '/api/projects/{slug}/threads/{id}/publish'],
  ['post', '/api/projects/{slug}/threads/{id}/discard'],
  ['post', '/api/projects/{slug}/threads/{id}/messages'],
  ['post', '/api/threads'],
  ['patch', '/api/threads/{id}'],
  ['post', '/api/threads/{id}/messages'],
  ['post', '/api/threads/{id}/archive'],
  ['post', '/api/threads/{id}/stop'],
  ['post', '/api/threads/{id}/end-session'],
  ['post', '/api/threads/{id}/answer'],
] as const;

/** The `gate-secret` redeem pilots (US-006, US-007), as [method, path] pairs. */
const REDEEM_PILOTS = [
  ['post', '/api/agents'],
  ['post', '/api/agents/{slug}/rotate-key'],
  ['post', '/api/admin/users'],
] as const;

function operationsWith202(): string[] {
  return Object.entries(openapi.paths).flatMap(([path, methods]) =>
    Object.entries(methods)
      .filter(([, operation]) => operation.responses?.['202'] !== undefined)
      .map(([method]) => `${method.toLowerCase()} ${path}`),
  ).sort();
}

describe('OpenAPI contract for 118 gated operations', () => {
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

  it('AC-14 (US-007): the three redeem pilots document a 202 and the redemption header', () => {
    for (const [method, path] of REDEEM_PILOTS) {
      const operation = openapi.paths[path]?.[method];
      expect(operation?.responses, `${method} ${path} 202`).toHaveProperty('202');
      expect(operation?.parameters ?? [], `${method} ${path} header`).toContainEqual(
        expect.objectContaining({ name: 'X-Koda-Approval-Request', in: 'header' }),
      );
    }
  });

  /**
   * Fix round 1 (F1): the header is optional, and a handler parameter reflected by `@Headers()`
   * documented it a second time as a required one. Exactly one header parameter may exist, and it is
   * the optional one the route advertises.
   */
  it('AC-14 (US-007): each redeem pilot documents the header exactly once, and as optional', () => {
    for (const [method, path] of REDEEM_PILOTS) {
      const headers = (openapi.paths[path]?.[method]?.parameters ?? [])
        .filter((parameter) => parameter.in === 'header');

      expect(headers, `${method} ${path}`).toHaveLength(1);
      expect(headers[0]).toMatchObject({ name: 'X-Koda-Approval-Request', required: false });
    }
  });

  it('AC-7: POST knowledge-base search has no 202 response', () => {
    expect(openapi.paths['/api/projects/{slug}/kb/search']?.post?.responses).not.toHaveProperty('202');
  });

  it('AC-5: POST /api/projects/{slug}/fleet/jobs has a 202 response', () => {
    expect(openapi.paths['/api/projects/{slug}/fleet/jobs']?.post?.responses).toHaveProperty('202');
  });

  it('US-009 AC-4: project message and workspace create operations have a 202 response', () => {
    expect(openapi.paths['/api/projects/{slug}/threads/{id}/messages']?.post?.responses).toHaveProperty('202');
    expect(openapi.paths['/api/threads']?.post?.responses).toHaveProperty('202');
  });

  it('AC-15 (US-007): 202 responses exist on exactly the 118 gated operations', () => {
    const expected = gatedOperations.map(([method, path]) => `${method} ${path}`).sort();
    expect(expected).toHaveLength(118);
    expect(operationsWith202()).toEqual(expected);
  });
});
