import { Command } from 'commander';
import { adminUsersControllerCreate, adminUsersControllerList, adminUsersControllerUpdate } from '../generated';
import { table } from '../utils/output';
import { unwrap } from '../utils/api';
import { handleApiError } from '../utils/error';
import { withContext } from '../utils/context';

interface UserRow {
  id: string;
  email: string;
  name?: string | null;
  role: string;
  disabled: boolean;
}

interface UserPage {
  total: number;
  current: number;
  hasNext: boolean;
  records: UserRow[];
}

// Agent API keys never hold the global ADMIN authority; these routes need a
// global-admin user's access token (15 min) passed through KODA_API_KEY.
const TOKEN_HINT = 'Requires a global-admin user access token: KODA_API_KEY=<token> koda user …';

export function userCommand(program: Command): void {
  const user = program.command('user');
  user.description(`Global user administration. ${TOKEN_HINT}`);

  user
    .command('list')
    .description('List users')
    .option('--email <text>', 'Filter by email substring (case-insensitive)')
    .option('--page <n>', 'Page number', '1')
    .option('--size <n>', 'Page size (1-100)', '20')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        await withContext({}, { requireProject: false });
        const response = await adminUsersControllerList({
          query: { email: options.email, current: parseInt(options.page, 10), size: parseInt(options.size, 10) },
        });
        const page = unwrap<UserPage>(response);
        if (options.json) {
          console.log(JSON.stringify(page, null, 2));
        } else {
          const rows = page.records.map((u) => [u.id, u.email, u.name ?? '', u.role, u.disabled ? 'yes' : 'no']);
          table(['ID', 'Email', 'Name', 'Role', 'Disabled'], rows);
          if (page.hasNext) console.log(`Next: --page ${page.current + 1}`);
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  user
    .command('create')
    .description('Create a user with a temporary password')
    .requiredOption('--email <email>', 'Email address')
    .requiredOption('--name <name>', 'Display name')
    .requiredOption('--password <password>', 'Temporary password (min 8 chars, mixed case, digit, symbol)')
    .option('--role <role>', 'Global role: MEMBER or ADMIN', 'MEMBER')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        await withContext({}, { requireProject: false });
        const response = await adminUsersControllerCreate({
          body: { email: options.email, name: options.name, password: options.password, role: options.role as 'MEMBER' | 'ADMIN' },
        });
        const created = unwrap<UserRow>(response);
        if (options.json) console.log(JSON.stringify(created, null, 2));
        else console.log(`User created: ${created.email} (${created.id})`);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  user
    .command('disable <userId>')
    .description('Disable a user and revoke all of their sessions')
    .option('--json', 'Output as JSON')
    .action(async (userId: string, options) => {
      try {
        await withContext({}, { requireProject: false });
        const response = await adminUsersControllerUpdate({ path: { id: userId }, body: { disabled: true } });
        const updated = unwrap<UserRow>(response);
        if (options.json) console.log(JSON.stringify(updated, null, 2));
        else console.log(`User disabled: ${userId}`);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `User not found: ${userId}` });
      }
    });
}
