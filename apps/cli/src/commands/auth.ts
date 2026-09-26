import { Command } from 'commander';
import { resolveContext, clearApiKey } from '../config';
import {
  authControllerMe,
  authControllerRegister,
  authControllerLogout,
} from '../generated';
import { table } from '../utils/output';
import { configureApiClient } from '../utils/api-client';
import { unwrap } from '../utils/api';
import { handleApiError } from '../utils/error';
import { withContext } from '../utils/context';

export function authCommand(program: Command): void {
  const auth = program.command('auth');
  auth.description('Authentication and user account management');

  auth
    .command('me')
    .description('Show the currently authenticated user')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        await withContext({}, { requireProject: false });

        const response = await authControllerMe();
        const data = unwrap<Record<string, unknown>>(response);

        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          const rows = [
            ['ID', String(data['id'] ?? '')],
            ['Email', String(data['email'] ?? '')],
            ['Name', String(data['name'] ?? '')],
            ['Role', String(data['role'] ?? '')],
          ];
          table(['Field', 'Value'], rows);
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  auth
    .command('register')
    .description('Register a new user account')
    .requiredOption('--email <email>', 'Email address')
    .requiredOption('--password <password>', 'Password (min 8 chars, mixed case, digit, symbol)')
    .option('--name <name>', 'Display name')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const ctx = await resolveContext({});
        if (!ctx.apiUrl) {
          handleApiError(new Error('API URL not configured. Run: koda login --api-key <key>'), { configError: true });
        }

        configureApiClient(ctx.apiUrl.replace(/\/api\/?$/, ''));

        const response = await authControllerRegister({
          body: { email: options.email, password: options.password, name: options.name },
        });
        const data = unwrap<Record<string, unknown>>(response);

        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          console.log(`User registered: ${String(data['email'] ?? options.email)}`);
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  auth
    .command('logout')
    .description('Revoke all outstanding access and refresh tokens for the current user')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        await withContext({}, { requireProject: false });

        await authControllerLogout();
        clearApiKey();

        if (options.json) {
          console.log(JSON.stringify({ success: true }, null, 2));
        } else {
          console.log(
            'Logged out. Server-side tokens revoked and the cached API key cleared from global config ' +
              '(profile-, project-, or env-provided keys are not affected).',
          );
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });
}
