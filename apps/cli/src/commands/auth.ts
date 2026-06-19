import { Command } from 'commander';
import { resolveContext } from '../config';
import { OpenAPI } from '../generated/core/OpenAPI';
import {
  authControllerMe,
  authControllerRegister,
} from '../generated';
import { table } from '../utils/output';
import { unwrap } from '../utils/api';
import { handleApiError } from '../utils/error';

export function authCommand(program: Command): void {
  const auth = program.command('auth');
  auth.description('Authentication and user account management');

  auth
    .command('me')
    .description('Show the currently authenticated user')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const ctx = await resolveContext({});
        if (!ctx.apiKey || !ctx.apiUrl) {
          handleApiError(new Error('API key or URL not configured. Run: koda login --api-key <key>'), { configError: true });
        }

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = ctx.apiKey;

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

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');

        const response = await authControllerRegister({
          requestBody: { email: options.email, password: options.password, name: options.name },
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
}
