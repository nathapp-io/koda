import { Command } from 'commander';
import {
  projectMembersControllerAdd,
  projectMembersControllerList,
  projectMembersControllerRemove,
  projectMembersControllerUpdateRole,
} from '../generated';
import { table } from '../utils/output';
import { unwrap } from '../utils/api';
import { handleApiError } from '../utils/error';
import { withContext } from '../utils/context';

interface MemberRow {
  userId: string;
  email: string;
  name?: string | null;
  role: string;
  joinedAt?: string;
}

interface MemberPage {
  total: number;
  current: number;
  hasNext: boolean;
  records: MemberRow[];
}

type AssignableRole = 'ADMIN' | 'DEVELOPER' | 'VIEWER';

// Listing works with an agent key. Add/role/remove need a project-admin or
// global-admin user access token passed through KODA_API_KEY.
export function memberCommand(program: Command): void {
  const member = program.command('member');
  member.description('Project membership. Writes need a project-admin user access token (KODA_API_KEY=<token>).');

  member
    .command('list')
    .description('List project members')
    .option('--project <slug>', 'Project slug')
    .option('--page <n>', 'Page number', '1')
    .option('--size <n>', 'Page size (1-100)', '20')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const ctx = await withContext({ projectSlug: options.project });
        const response = await projectMembersControllerList({
          path: { slug: ctx.projectSlug },
          query: { current: parseInt(options.page, 10), size: parseInt(options.size, 10) },
        });
        const page = unwrap<MemberPage>(response);
        if (options.json) {
          console.log(JSON.stringify(page, null, 2));
        } else {
          table(['User ID', 'Email', 'Name', 'Role'], page.records.map((m) => [m.userId, m.email, m.name ?? '', m.role]));
          if (page.hasNext) console.log(`Next: --page ${page.current + 1}`);
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  member
    .command('add')
    .description('Add an existing user to the project by email')
    .requiredOption('--email <email>', 'Email of an existing user')
    .requiredOption('--role <role>', 'ADMIN, DEVELOPER or VIEWER')
    .option('--project <slug>', 'Project slug')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const ctx = await withContext({ projectSlug: options.project });
        const response = await projectMembersControllerAdd({
          path: { slug: ctx.projectSlug },
          body: { email: options.email, role: options.role as AssignableRole },
        });
        const added = unwrap<MemberRow>(response);
        if (options.json) console.log(JSON.stringify(added, null, 2));
        else console.log(`Added ${added.email} as ${added.role}`);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `No user with email ${options.email} (or project not found)` });
      }
    });

  member
    .command('role <userId>')
    .description('Change a member\'s project role')
    .requiredOption('--role <role>', 'ADMIN, DEVELOPER or VIEWER')
    .option('--project <slug>', 'Project slug')
    .option('--json', 'Output as JSON')
    .action(async (userId: string, options) => {
      try {
        const ctx = await withContext({ projectSlug: options.project });
        const response = await projectMembersControllerUpdateRole({
          path: { slug: ctx.projectSlug, userId },
          body: { role: options.role as AssignableRole },
        });
        const updated = unwrap<MemberRow>(response);
        if (options.json) console.log(JSON.stringify(updated, null, 2));
        else console.log(`${updated.email} is now ${updated.role}`);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Not a member: ${userId}` });
      }
    });

  member
    .command('remove <userId>')
    .description('Remove a member from the project')
    .option('--project <slug>', 'Project slug')
    .option('--json', 'Output as JSON')
    .action(async (userId: string, options) => {
      try {
        const ctx = await withContext({ projectSlug: options.project });
        await projectMembersControllerRemove({ path: { slug: ctx.projectSlug, userId } });
        if (options.json) console.log(JSON.stringify({ removed: userId }, null, 2));
        else console.log(`Removed ${userId}`);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Not a member: ${userId}` });
      }
    });
}
