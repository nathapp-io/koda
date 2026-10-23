import { Command } from 'commander';
import {
  agentsControllerFindBySlug,
  projectsControllerFindBySlug,
  roleBindingsControllerCreate,
  roleBindingsControllerList,
  roleBindingsControllerRemove,
} from '../generated';
import { unwrap } from '../utils/api';
import { handleApiError } from '../utils/error';
import { withContext } from '../utils/context';
import { table } from '../utils/output';
import { parsePositiveInt } from '../utils/parse-positive-int';

type PrincipalType = 'USER' | 'AGENT';

interface RoleBindingRow {
  id: string;
  principalType: PrincipalType;
  principalId: string;
  roleKey: string;
  projectId: string | null;
  createdAt: string;
}

interface RoleBindingPage {
  total: number;
  current: number;
  hasNext: boolean;
  records: RoleBindingRow[];
}

interface ListQuery {
  current: number;
  size: number;
  projectId?: string;
  scope?: 'global';
  principalType?: PrincipalType;
  principalId?: string;
}

/** Resolve an explicit `--project <slug>` to the id the role-binding API filters and grants on. */
async function resolveProjectId(slug: string): Promise<string> {
  const response = await projectsControllerFindBySlug({ path: { slug } });
  return unwrap<{ id: string }>(response).id;
}

/** Resolve an explicit `--agent <slug>` to the agent id a binding names. */
async function resolveAgentId(slug: string): Promise<string> {
  const response = await agentsControllerFindBySlug({ path: { slug } });
  return unwrap<{ id: string }>(response).id;
}

/**
 * `koda role-binding` — grants of roles (project and global) to users and agents.
 *
 * The CLI speaks role keys and principal ids only: it never validates a role key, never decides
 * which role may be granted where, and never checks flag combinations the API could refuse —
 * those refusals arrive as API errors and go through `handleApiError` unchanged.
 *
 * Context is resolved without a project (as `user list` does) and the context's `projectSlug` is
 * never read: no `--project` means a global binding or no project filter, never the local config's
 * project.
 */
export function roleBindingCommand(program: Command): void {
  const roleBinding = program.command('role-binding');

  roleBinding.description('Manage role bindings: which user or agent holds which role, where');

  roleBinding
    .command('list')
    .description('List role bindings')
    .option('--project <slug>', 'Only bindings of this project')
    .option('--global', 'Only bindings with no project')
    .option('--type <type>', 'Filter by principal type: USER or AGENT')
    .option('--principal <id>', 'Narrow to one principal id (requires --type)')
    .option('--page <n>', 'Page number', parsePositiveInt, 1)
    .option('--size <n>', 'Page size (1-200)', parsePositiveInt, 20)
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        await withContext({}, { requireProject: false });

        const query: ListQuery = { current: options.page, size: options.size };
        if (options.project) query.projectId = await resolveProjectId(options.project);
        if (options.global) query.scope = 'global';
        if (options.type) query.principalType = options.type as PrincipalType;
        if (options.principal) query.principalId = options.principal;

        const response = await roleBindingsControllerList({ query });
        const page = unwrap<RoleBindingPage>(response);

        if (options.json) {
          console.log(JSON.stringify(page, null, 2));
        } else {
          table(
            ['ID', 'Type', 'Principal', 'Role', 'Project', 'Granted'],
            page.records.map((binding) => [
              binding.id,
              binding.principalType,
              binding.principalId,
              binding.roleKey,
              binding.projectId ?? 'global',
              binding.createdAt,
            ]),
          );
          if (page.hasNext) console.log(`Next: --page ${page.current + 1}`);
        }

        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  roleBinding
    .command('grant')
    .description('Grant a role to a user or an agent, globally or in one project')
    .requiredOption('--role <key>', 'Role key, e.g. project-admin, developer, viewer')
    .option('--user <userId>', 'User id to grant the role to')
    .option('--agent <slug>', 'Agent slug to grant the role to')
    .option('--project <slug>', 'Project slug (omit for a global binding)')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      // Exactly one principal, decided before any lookup or request.
      if (Boolean(options.user) === Boolean(options.agent)) {
        handleApiError(new Error('Choose exactly one of --user or --agent'), { validationError: true });
        return;
      }

      try {
        await withContext({}, { requireProject: false });

        const principalType: PrincipalType = options.user ? 'USER' : 'AGENT';
        const principalId: string = options.user
          ? options.user
          : await resolveAgentId(options.agent);
        const principalLabel: string = options.user ?? options.agent;
        const projectId = options.project ? await resolveProjectId(options.project) : null;

        const response = await roleBindingsControllerCreate({
          body: { principalType, principalId, roleKey: options.role, projectId },
        });
        const binding = unwrap<RoleBindingRow>(response);

        if (options.json) {
          console.log(JSON.stringify(binding, null, 2));
        } else {
          console.log(`Granted ${binding.roleKey} to ${principalLabel} (binding ${binding.id})`);
        }

        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  roleBinding
    .command('revoke <bindingId>')
    .description('Revoke a role binding')
    .option('--json', 'Output as JSON')
    .action(async (bindingId: string, options) => {
      try {
        await withContext({}, { requireProject: false });

        await roleBindingsControllerRemove({ path: { id: bindingId } });

        if (options.json) console.log(JSON.stringify({ revoked: bindingId }, null, 2));
        else console.log(`Revoked ${bindingId}`);

        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });
}
