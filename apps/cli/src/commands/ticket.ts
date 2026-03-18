import { Command } from 'commander';
import { resolveAuth } from '../utils/auth';
import { configureClient } from '../client';
import { TicketsService } from '../generated';
import { table, error } from '../utils/output';

export function ticketCommand(program: Command): void {
  const ticket = program.command('ticket');

  ticket.description('Manage tickets');

  ticket
    .command('create')
    .description('Create a new ticket')
    .option('--project <slug>', 'Project slug')
    .option('--type <type>', 'Ticket type (bug|enhancement)')
    .option('--title <title>', 'Ticket title')
    .option('--desc <description>', 'Ticket description')
    .option('--priority <priority>', 'Priority (low|medium|high|critical)')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        // Validate required options
        if (!options.project || !options.type || !options.title) {
          error('Missing required options: --project, --type, and --title are required');
          process.exit(3);
        }

        const auth = resolveAuth({});

        if (!auth.apiKey || !auth.apiUrl) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
        }

        const client = configureClient(auth.apiUrl, auth.apiKey);
        const response = await TicketsService.create(client, {
          projectSlug: options.project,
          type: options.type,
          title: options.title,
          description: options.desc,
          priority: options.priority,
        });

        if (options.json) {
          console.log(JSON.stringify(response.data, null, 2));
        } else {
          console.log(`✓ Ticket created successfully`);
        }

        process.exit(0);
      } catch (err: unknown) {
        const apiError = err as { response?: { status?: number }; message?: string };
        const statusCode = apiError.response?.status;
        if (statusCode === 401 || statusCode === 403) {
          error('Unauthorized. Please check your API key.');
          process.exit(2);
        }
        error(apiError.message || 'Failed to create ticket');
        process.exit(1);
      }
    });

  ticket
    .command('list')
    .description('List tickets')
    .requiredOption('--project <slug>', 'Project slug')
    .option('--status <status>', 'Filter by status')
    .option('--type <type>', 'Filter by type')
    .option('--priority <priority>', 'Filter by priority')
    .option('--assigned-to <slug>', 'Filter by assignee')
    .option('--unassigned', 'Show only unassigned tickets')
    .option('--limit <number>', 'Items per page', '20')
    .option('--page <number>', 'Page number', '1')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const auth = resolveAuth({});

        if (!auth.apiKey || !auth.apiUrl) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
        }

        const client = configureClient(auth.apiUrl, auth.apiKey);
        const response = await TicketsService.list(client, {
          projectSlug: options.project,
          status: options.status,
          type: options.type,
          priority: options.priority,
          assignedTo: options.assignedTo,
          unassigned: options.unassigned ? true : undefined,
          limit: parseInt(options.limit, 10),
          page: parseInt(options.page, 10),
        });

        if (options.json) {
          console.log(JSON.stringify(response.data, null, 2));
        } else {
          const rows = response.data.map((t) => [
            `KODA-${t.number}`,
            t.type,
            t.priority || '',
            t.status,
            t.assignee?.name || '—',
            t.title,
          ]);
          table(['#', 'Type', 'Priority', 'Status', 'Assignee', 'Title'], rows);
        }

        process.exit(0);
      } catch (err: unknown) {
        const apiError = err as { response?: { status?: number }; message?: string };
        const statusCode = apiError.response?.status;
        if (statusCode === 401 || statusCode === 403) {
          error('Unauthorized. Please check your API key.');
          process.exit(2);
        }
        error(apiError.message || 'Failed to list tickets');
        process.exit(1);
      }
    });

  ticket
    .command('mine')
    .description('List tickets assigned to me')
    .option('--project <slug>', 'Filter by project')
    .option('--status <status>', 'Filter by status')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const auth = resolveAuth({});

        if (!auth.apiKey || !auth.apiUrl) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
        }

        const client = configureClient(auth.apiUrl, auth.apiKey);
        const response = await TicketsService.list(client, {
          projectSlug: options.project,
          status: options.status,
          assignedTo: 'self',
        });

        if (options.json) {
          console.log(JSON.stringify(response.data, null, 2));
        } else {
          const rows = response.data.map((t) => [
            `KODA-${t.number}`,
            t.type,
            t.priority || '',
            t.status,
            t.assignee?.name || '—',
            t.title,
          ]);
          table(['#', 'Type', 'Priority', 'Status', 'Assignee', 'Title'], rows);
        }

        process.exit(0);
      } catch (err: unknown) {
        const apiError = err as { response?: { status?: number }; message?: string };
        const statusCode = apiError.response?.status;
        if (statusCode === 401 || statusCode === 403) {
          error('Unauthorized. Please check your API key.');
          process.exit(2);
        }
        error(apiError.message || 'Failed to list tickets');
        process.exit(1);
      }
    });

  ticket
    .command('show <ref>')
    .description('Show ticket details')
    .option('--json', 'Output as JSON')
    .action(async (ref: string, options) => {
      try {
        const auth = resolveAuth({});

        if (!auth.apiKey || !auth.apiUrl) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
        }

        const client = configureClient(auth.apiUrl, auth.apiKey);
        const response = await TicketsService.show(client, ref);

        if (options.json) {
          console.log(JSON.stringify(response.data, null, 2));
        } else {
          const ticket = response.data;
          console.log(`\n${'Ticket Details'}:`);
          console.log(`ID: ${ticket.id}`);
          console.log(`Reference: KODA-${ticket.number}`);
          console.log(`Type: ${ticket.type}`);
          console.log(`Title: ${ticket.title}`);
          if (ticket.description) {
            console.log(`Description: ${ticket.description}`);
          }
          console.log(`Status: ${ticket.status}`);
          console.log(`Priority: ${ticket.priority || 'N/A'}`);
          console.log(`Assignee: ${ticket.assignee?.name || 'Unassigned'}`);
          console.log(`Created: ${ticket.createdAt}`);
          console.log(`Updated: ${ticket.updatedAt}`);

          if (ticket.comments && ticket.comments.length > 0) {
            console.log(`\nComments:`);
            for (const comment of ticket.comments) {
              const author = comment.author?.name || 'Unknown';
              console.log(
                `  - ${author} (${comment.type}): ${comment.body}`
              );
            }
          }
        }

        process.exit(0);
      } catch (err: unknown) {
        const apiError = err as { response?: { status?: number }; message?: string };
        const statusCode = apiError.response?.status;
        if (statusCode === 401 || statusCode === 403) {
          error('Unauthorized. Please check your API key.');
          process.exit(2);
        }
        if (statusCode === 404) {
          error(`Ticket not found: ${ref}`);
          process.exit(1);
        }
        error(apiError.message || 'Failed to fetch ticket');
        process.exit(1);
      }
    });

  ticket
    .command('verify <ref>')
    .description('Verify a ticket (CREATED → VERIFIED)')
    .option('--comment <text>', 'Verification comment')
    .action(async (ref: string, options) => {
      try {
        // Validate required options
        if (!options.comment) {
          error('Missing required option: --comment is required');
          process.exit(3);
        }

        const auth = resolveAuth({});

        if (!auth.apiKey || !auth.apiUrl) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
        }

        const client = configureClient(auth.apiUrl, auth.apiKey);
        await TicketsService.verify(client, ref, {
          body: options.comment,
          type: 'verification',
        });

        console.log(`✓ Ticket verified successfully`);
        process.exit(0);
      } catch (err: unknown) {
        const apiError = err as { response?: { status?: number }; message?: string };
        const statusCode = apiError.response?.status;
        if (statusCode === 401 || statusCode === 403) {
          error('Unauthorized. Please check your API key.');
          process.exit(2);
        }
        error(apiError.message || 'Failed to verify ticket');
        process.exit(1);
      }
    });

  ticket
    .command('assign <ref>')
    .description('Assign a ticket')
    .option('--to <agent-slug>', 'Agent to assign to (omit for self-assign)')
    .action(async (ref: string, options) => {
      try {
        const auth = resolveAuth({});

        if (!auth.apiKey || !auth.apiUrl) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
        }

        const client = configureClient(auth.apiUrl, auth.apiKey);
        await TicketsService.assign(client, ref, {
          agentSlug: options.to || 'self',
        });

        console.log(`✓ Ticket assigned successfully`);
        process.exit(0);
      } catch (err: unknown) {
        const apiError = err as { response?: { status?: number }; message?: string };
        const statusCode = apiError.response?.status;
        if (statusCode === 401 || statusCode === 403) {
          error('Unauthorized. Please check your API key.');
          process.exit(2);
        }
        error(apiError.message || 'Failed to assign ticket');
        process.exit(1);
      }
    });

  ticket
    .command('start <ref>')
    .description('Start a ticket (VERIFIED → IN_PROGRESS)')
    .action(async (ref: string) => {
      try {
        const auth = resolveAuth({});

        if (!auth.apiKey || !auth.apiUrl) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
        }

        const client = configureClient(auth.apiUrl, auth.apiKey);
        await TicketsService.start(client, ref);

        console.log(`✓ Ticket started successfully`);
        process.exit(0);
      } catch (err: unknown) {
        const apiError = err as { response?: { status?: number }; message?: string };
        const statusCode = apiError.response?.status;
        if (statusCode === 401 || statusCode === 403) {
          error('Unauthorized. Please check your API key.');
          process.exit(2);
        }
        error(apiError.message || 'Failed to start ticket');
        process.exit(1);
      }
    });

  ticket
    .command('fix <ref>')
    .description('Submit a fix for a ticket (IN_PROGRESS → VERIFY_FIX)')
    .option('--comment <text>', 'Fix report comment')
    .option('--git-ref <ref>', 'Git reference (e.g. v1.0:src/auth.ts:42)')
    .action(async (ref: string, options) => {
      try {
        // Validate required options
        if (!options.comment) {
          error('Missing required option: --comment is required');
          process.exit(3);
        }

        const auth = resolveAuth({});

        if (!auth.apiKey || !auth.apiUrl) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
        }

        const client = configureClient(auth.apiUrl, auth.apiKey);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const payload: any = {
          body: options.comment,
          type: 'fix_report',
        };
        if (options.gitRef) {
          payload.gitRef = options.gitRef;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await TicketsService.fix(client, ref, payload as any);

        console.log(`✓ Fix submitted successfully`);
        process.exit(0);
      } catch (err: unknown) {
        const apiError = err as { response?: { status?: number }; message?: string };
        const statusCode = apiError.response?.status;
        if (statusCode === 401 || statusCode === 403) {
          error('Unauthorized. Please check your API key.');
          process.exit(2);
        }
        error(apiError.message || 'Failed to submit fix');
        process.exit(1);
      }
    });

  ticket
    .command('verify-fix <ref>')
    .description('Verify a fix (VERIFY_FIX → CLOSED or → IN_PROGRESS)')
    .option('--comment <text>', 'Review comment')
    .option('--pass', 'Mark fix as passing (closes ticket)')
    .option('--fail', 'Mark fix as failing (returns to IN_PROGRESS)')
    .action(async (ref: string, options) => {
      try {
        // Validate required options
        if (!options.comment) {
          error('Missing required option: --comment is required');
          process.exit(3);
        }

        const auth = resolveAuth({});

        if (!auth.apiKey || !auth.apiUrl) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
        }

        const client = configureClient(auth.apiUrl, auth.apiKey);
        const status = options.pass ? 'closed' : 'in_progress';
        await TicketsService.verifyFix(client, ref, {
          body: options.comment,
          type: 'review',
          status,
        });

        console.log(`✓ Fix verification submitted successfully`);
        process.exit(0);
      } catch (err: unknown) {
        const apiError = err as { response?: { status?: number }; message?: string };
        const statusCode = apiError.response?.status;
        if (statusCode === 401 || statusCode === 403) {
          error('Unauthorized. Please check your API key.');
          process.exit(2);
        }
        error(apiError.message || 'Failed to verify fix');
        process.exit(1);
      }
    });

  ticket
    .command('close <ref>')
    .description('Close a ticket')
    .action(async (ref: string) => {
      try {
        const auth = resolveAuth({});

        if (!auth.apiKey || !auth.apiUrl) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
        }

        const client = configureClient(auth.apiUrl, auth.apiKey);
        await TicketsService.close(client, ref);

        console.log(`✓ Ticket closed successfully`);
        process.exit(0);
      } catch (err: unknown) {
        const apiError = err as { response?: { status?: number }; message?: string };
        const statusCode = apiError.response?.status;
        if (statusCode === 401 || statusCode === 403) {
          error('Unauthorized. Please check your API key.');
          process.exit(2);
        }
        error(apiError.message || 'Failed to close ticket');
        process.exit(1);
      }
    });

  ticket
    .command('reject <ref>')
    .description('Reject a ticket')
    .option('--comment <text>', 'Rejection reason')
    .action(async (ref: string, options) => {
      try {
        // Validate required options
        if (!options.comment) {
          error('Missing required option: --comment is required');
          process.exit(3);
        }

        const auth = resolveAuth({});

        if (!auth.apiKey || !auth.apiUrl) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
        }

        const client = configureClient(auth.apiUrl, auth.apiKey);
        await TicketsService.reject(client, ref, {
          body: options.comment,
          type: 'general',
        });

        console.log(`✓ Ticket rejected successfully`);
        process.exit(0);
      } catch (err: unknown) {
        const apiError = err as { response?: { status?: number }; message?: string };
        const statusCode = apiError.response?.status;
        if (statusCode === 401 || statusCode === 403) {
          error('Unauthorized. Please check your API key.');
          process.exit(2);
        }
        error(apiError.message || 'Failed to reject ticket');
        process.exit(1);
      }
    });

  ticket
    .command('open <ref>')
    .description('Open ticket in browser')
    .option('--project <slug>', 'Project slug (optional, inferred from ticket if available)')
    .action(async (ref: string, options) => {
      try {
        const auth = resolveAuth({});

        if (!auth.apiKey || !auth.apiUrl) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
        }

        const client = configureClient(auth.apiUrl, auth.apiKey);
        const response = await TicketsService.show(client, ref);
        const ticket = response.data;

        // Extract base URL from API URL (e.g., http://localhost:3100/api -> http://localhost:3100)
        const baseUrl = auth.apiUrl.replace(/\/api\/?$/, '');
        // Use project slug if provided, otherwise use a placeholder or projectId
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const projectIdentifier = options.project || (ticket as any).project?.slug || (ticket as any).projectId;
        const ticketUrl = `${baseUrl}/projects/${projectIdentifier}/tickets/${ticket.number}`;

        // Use system command to open URL in default browser
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { execFile } = require('child_process');
        execFile(
          process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open',
          process.platform === 'win32' ? ['/c', `start ${ticketUrl}`] : [ticketUrl],
          { stdio: 'ignore' },
          (error: unknown) => {
            if (error) {
              // If system command fails, just print the URL
              console.log(`Open this URL in your browser: ${ticketUrl}`);
            }
          }
        );

        console.log(`✓ Opening ticket in browser`);
        process.exit(0);
      } catch (err: unknown) {
        const apiError = err as { response?: { status?: number }; message?: string };
        const statusCode = apiError.response?.status;
        if (statusCode === 401 || statusCode === 403) {
          error('Unauthorized. Please check your API key.');
          process.exit(2);
        }
        if (statusCode === 404) {
          error(`Ticket not found: ${ref}`);
          process.exit(1);
        }
        error(apiError.message || 'Failed to open ticket');
        process.exit(1);
      }
    });
}
