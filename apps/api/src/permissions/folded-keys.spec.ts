/**
 * Permissions P1g US-001: the five removed keys are folded into their surviving keys.
 *
 * The design (Appendix A of `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md`)
 * removes `project.agent.add`, `project.agent.remove`, `project.agent.update`, `member.role.update`
 * and `agent.roles.update`: they duplicate what `member.*`, `role.binding.manage` and `agent.update`
 * already express. This spec pins the fold — the catalog, the surviving keys' scopes, the seeded
 * project-admin role, the five route declarations that used the removed keys and the route texts
 * that name the surviving keys.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { AgentsController } from '../agents/agents.controller';
import { ProjectMembersController } from '../projects/members/project-members.controller';
import { ProjectsController } from '../projects/projects.controller';
import { findCatalogEntry, PERMISSION_CATALOG } from './catalog';
import { expandEntries } from './entry-matcher';
import { REQUIRES_METADATA, type RequiresMetadata } from './requires.decorator';
import { SYSTEM_ROLES } from './system-roles';

/** The keys the design removes; none of them may survive in the catalog. */
const REMOVED_KEYS: readonly string[] = [
  'project.agent.add',
  'project.agent.remove',
  'project.agent.update',
  'member.role.update',
  'agent.roles.update',
];

/**
 * @nestjs/swagger's metadata keys. Its `DECORATORS` map is not exported from the package root,
 * so the two literals the `ApiOperation` and `ApiResponse` decorators write are spelled out here.
 */
const API_OPERATION_METADATA = 'swagger/apiOperation';
const API_RESPONSE_METADATA = 'swagger/apiResponse';

interface SwaggerOperation {
  summary?: string;
}

type SwaggerResponses = Record<string, { description?: string } | undefined>;

/**
 * The five routes the fold rewires: the route, its handler and the surviving key its texts name.
 */
const FOLDED_ROUTES: ReadonlyArray<readonly [route: string, handler: object, key: string]> = [
  ['POST /projects/:slug/agents', ProjectsController.prototype.addProjectAgent, 'member.add'],
  ['DELETE /projects/:slug/agents/:agentSlug', ProjectsController.prototype.removeProjectAgent, 'member.remove'],
  ['PATCH /projects/:slug/agents/:agentSlug', ProjectsController.prototype.updateProjectAgent, 'agent.update'],
  ['PATCH /projects/:slug/members/:userId', ProjectMembersController.prototype.updateRole, 'role.binding.manage'],
  ['PATCH /agents/:slug/update-roles', AgentsController.prototype.updateRoles, 'agent.update'],
];

/**
 * The same five routes in the committed spec: the spec path, the method and the surviving key.
 */
const FOLDED_OPERATIONS: ReadonlyArray<readonly [path: string, method: string, key: string]> = [
  ['/api/projects/{slug}/agents', 'post', 'member.add'],
  ['/api/projects/{slug}/agents/{agentSlug}', 'delete', 'member.remove'],
  ['/api/projects/{slug}/agents/{agentSlug}', 'patch', 'agent.update'],
  ['/api/projects/{slug}/members/{userId}', 'patch', 'role.binding.manage'],
  ['/api/agents/{slug}/update-roles', 'patch', 'agent.update'],
];

interface OpenApiSpec {
  paths: Record<string, Record<string, { summary?: string; responses?: SwaggerResponses } | undefined>>;
}

/** The committed spec, regenerated with `bun run api:export-spec` from the repo root. */
function committedSpec(): OpenApiSpec {
  const raw = readFileSync(join(__dirname, '..', '..', '..', '..', 'openapi.json'), 'utf-8');
  return JSON.parse(raw) as OpenApiSpec;
}

/** The keys of one handler, read off its `@Requires` metadata. */
function declaredKeys(handler: object): readonly string[] {
  const metadata = Reflect.getMetadata(REQUIRES_METADATA, handler) as RequiresMetadata | undefined;
  return metadata?.keys ?? [];
}

describe('the folded permission keys (US-001)', () => {
  it('AC-1: the catalog holds none of the five removed keys', () => {
    const catalogKeys = new Set(PERMISSION_CATALOG.map((entry) => entry.key));

    expect(REMOVED_KEYS.filter((key) => catalogKeys.has(key))).toEqual([]);
  });

  it('AC-2: role.binding.manage is one project-scope catalog entry', () => {
    const entries = PERMISSION_CATALOG.filter((entry) => entry.key === 'role.binding.manage');

    expect(entries).toHaveLength(1);
    expect(entries[0]?.scope).toBe('project');
  });

  it('AC-3: agent.update is a global-scope key', () => {
    expect(findCatalogEntry('agent.update')?.scope).toBe('global');
  });

  it('AC-4: the seeded project-admin role holds member.add, member.remove and role.binding.manage', () => {
    const role = SYSTEM_ROLES.find((entry) => entry.key === 'project-admin');
    if (!role) throw new Error('Missing seeded role: project-admin');

    const held = expandEntries(role.permissions, 'PROJECT');

    expect(held.has('member.add')).toBe(true);
    expect(held.has('member.remove')).toBe(true);
    expect(held.has('role.binding.manage')).toBe(true);
  });

  it('AC-5: the five folded routes declare the surviving keys', () => {
    const declared = {
      addProjectAgent: declaredKeys(ProjectsController.prototype.addProjectAgent),
      removeProjectAgent: declaredKeys(ProjectsController.prototype.removeProjectAgent),
      updateProjectAgent: declaredKeys(ProjectsController.prototype.updateProjectAgent),
      updateRole: declaredKeys(ProjectMembersController.prototype.updateRole),
      updateRoles: declaredKeys(AgentsController.prototype.updateRoles),
    };

    expect(declared).toEqual({
      addProjectAgent: ['member.add'],
      removeProjectAgent: ['member.remove'],
      updateProjectAgent: ['agent.update'],
      updateRole: ['role.binding.manage'],
      updateRoles: ['agent.update'],
    });
  });

  it('AC-6: every folded route names its surviving key in the operation and 403 texts', () => {
    for (const [route, handler, key] of FOLDED_ROUTES) {
      const operation = Reflect.getMetadata(API_OPERATION_METADATA, handler) as SwaggerOperation | undefined;
      const responses = Reflect.getMetadata(API_RESPONSE_METADATA, handler) as SwaggerResponses | undefined;

      expect(operation?.summary, `${route} operation summary`).toContain(key);
      expect(responses?.['403']?.description, `${route} 403 description`).toContain(key);
    }
  });

  it('AC-7: the committed openapi.json names the surviving keys on the folded operations', () => {
    const spec = committedSpec();

    for (const [path, method, key] of FOLDED_OPERATIONS) {
      const operation = spec.paths[path]?.[method];

      expect(operation?.summary, `${method.toUpperCase()} ${path} summary`).toContain(key);
      expect(operation?.responses?.['403']?.description, `${method.toUpperCase()} ${path} 403`).toContain(key);
    }
  });
});
