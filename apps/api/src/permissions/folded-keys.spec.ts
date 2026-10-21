/**
 * Permissions P1g US-001: the five removed keys are folded into their surviving keys.
 *
 * The design (Appendix A of `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md`)
 * removes `project.agent.add`, `project.agent.remove`, `project.agent.update`, `member.role.update`
 * and `agent.roles.update`: they duplicate what `member.*`, `role.binding.manage` and `agent.update`
 * already express. This spec pins the fold — the catalog, the surviving keys' scopes, the seeded
 * project-admin role and the five route declarations that used the removed keys.
 */
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
});
