import { Command } from 'commander';
import { resolveContext } from '../config';
import { configureClient } from '../client';
import { TicketsService, TicketLinksService, LabelsService, TicketLink } from '../generated';
import { table, error } from '../utils/output';
import { unwrap } from '../utils/api';
import { handleApiError } from '../utils/error';

export function ticketCommand(program: Command): void {
  const ticket = program.command('ticket');

  ticket.description('Manage tickets');

  ticket
    .command('create')
    .description('Create a new ticket')
    .option('--project <slug>', 'Project slug')
    .option('--type <type>', 'Ticket type (BUG|ENHANCEMENT|TASK|QUESTION)')
    .option('--title <title>', 'Ticket title')
    .option('--desc <description>', 'Ticket description')
    .option('--priority <priority>', 'Priority (LOW|MEDIUM|HIGH|CRITICAL)')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const ctx = await resolveContext({ projectSlug: options.project });

        if (!ctx.projectSlug) {
          error('Project not configured. Run: koda init');
          process.exit(2);
          return;
        }

        if (!ctx.apiKey) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
          return;
        }

        // Validate required options
        if (!options.type || !options.title) {
          error('Missing required options: --type and --title are required');
          process.exit(3);
        }

        const validTypes = ['BUG', 'ENHANCEMENT', 'TASK', 'QUESTION'];
        if (!validTypes.includes(options.type)) {
          error(`Invalid type ${options.type}. Valid values: ${validTypes.join(', ')}`);
          process.exit(3);
          return;
        }

        const validPriorities = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
        if (options.priority && !validPriorities.includes(options.priority)) {
          error(`Invalid priority ${options.priority}. Valid values: ${validPriorities.join(', ')}`);
          process.exit(3);
          return;
        }

        const client = configureClient(ctx.apiUrl, ctx.apiKey);
        const response = await TicketsService.create(client, ctx.projectSlug, {
          type: options.type,
          title: options.title,
          description: options.desc,
          priority: options.priority,
        });
        const ticketData = unwrap(response);

        if (options.json) {
          console.log(JSON.stringify(ticketData, null, 2));
          process.exit(0);
        } else {
          console.log(`✓ Ticket created successfully: ${ticketData.ref || `KODA-${ticketData.number}`}`);
          process.exit(0);
        }
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  ticket
    .command('list')
    .description('List tickets')
    .option('--project <slug>', 'Project slug')
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
        const ctx = await resolveContext({ projectSlug: options.project });

        if (!ctx.projectSlug) {
          error('Project not configured. Run: koda init');
          process.exit(2);
          return;
        }

        if (!ctx.apiKey) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
          return;
        }

        const client = configureClient(ctx.apiUrl, ctx.apiKey);

        const response = await TicketsService.list(client, {
          projectSlug: ctx.projectSlug,
          status: options.status,
          type: options.type,
          priority: options.priority,
          assignedTo: options.assignedTo,
          unassigned: options.unassigned ? true : undefined,
          limit: parseInt(options.limit, 10),
          page: parseInt(options.page, 10),
        });
        const data = unwrap(response);
        const items: Record<string, unknown>[] = Array.isArray(data) ? data : ((data as Record<string, unknown>).items as Record<string, unknown>[]) || [];

        if (options.json) {
          console.log(JSON.stringify(items, null, 2));
        } else {
          const rows = items.map((t) => [
            String(t.ref ?? `KODA-${t.number}`),
            String(t.type),
            String(t.priority || ''),
            String(t.status),
            String((t.assignee as Record<string, unknown> | undefined)?.name || '—'),
            String(t.title),
          ]);
          table(['#', 'Type', 'Priority', 'Status', 'Assignee', 'Title'], rows);
        }

        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
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
        const ctx = await resolveContext({ projectSlug: options.project });

        if (!ctx.projectSlug) {
          error('Project not configured. Run: koda init');
          process.exit(2);
          return;
        }

        if (!ctx.apiKey) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
          return;
        }

        const client = configureClient(ctx.apiUrl, ctx.apiKey);

        const response = await TicketsService.list(client, {
          projectSlug: ctx.projectSlug,
          status: options.status,
          assignedTo: 'self',
        });
        const data = unwrap(response);
        const items: Record<string, unknown>[] = Array.isArray(data) ? data : ((data as Record<string, unknown>).items as Record<string, unknown>[]) || [];

        if (options.json) {
          console.log(JSON.stringify(items, null, 2));
        } else {
          const rows = items.map((t) => [
            String(t.ref ?? `KODA-${t.number}`),
            String(t.type),
            String(t.priority || ''),
            String(t.status),
            String((t.assignee as Record<string, unknown> | undefined)?.name || '—'),
            String(t.title),
          ]);
          table(['#', 'Type', 'Priority', 'Status', 'Assignee', 'Title'], rows);
        }

        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  ticket
    .command('show <ref>')
    .description('Show ticket details')
    .option('--project <slug>', 'Project slug')
    .option('--json', 'Output as JSON')
    .action(async (ref: string, options) => {
      try {
        const ctx = await resolveContext({ projectSlug: options.project });

        if (!ctx.projectSlug) {
          error('Project not configured. Run: koda init');
          process.exit(2);
          return;
        }

        if (!ctx.apiKey) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
          return;
        }

        const client = configureClient(ctx.apiUrl, ctx.apiKey);

        const response = await TicketsService.show(client, ctx.projectSlug, ref);
        const ticketData = unwrap(response);

        if (options.json) {
          console.log(JSON.stringify(ticketData, null, 2));
        } else {
          console.log(`\n${'Ticket Details'}:`);
          console.log(`ID: ${ticketData.id}`);
          console.log(`Reference: ${ticketData.ref ?? `KODA-${ticketData.number}`}`);
          console.log(`Type: ${ticketData.type}`);
          console.log(`Title: ${ticketData.title}`);
          if (ticketData.description) {
            console.log(`Description: ${ticketData.description}`);
          }
          console.log(`Status: ${ticketData.status}`);
          console.log(`Priority: ${ticketData.priority || 'N/A'}`);
          console.log(`Assignee: ${ticketData.assignee?.name || 'Unassigned'}`);
          console.log(`Created: ${ticketData.createdAt}`);
          console.log(`Updated: ${ticketData.updatedAt}`);

          if (ticketData.comments && ticketData.comments.length > 0) {
            console.log(`\nComments:`);
            for (const comment of ticketData.comments) {
              const author = comment.author?.name || 'Unknown';
              console.log(
                `  - ${author} (${comment.type}): ${comment.body}`
              );
            }
          }
        }

        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Ticket not found: ${ref}` });
      }
    });

  ticket
    .command('verify <ref>')
    .description('Verify a ticket (CREATED → VERIFIED)')
    .option('--project <slug>', 'Project slug')
    .option('--comment <text>', 'Verification comment')
    .action(async (ref: string, options) => {
      try {
        if (!options.comment) {
          error('Comment is required');
          process.exit(3);
          return;
        }

        const ctx = await resolveContext({ projectSlug: options.project });

        if (!ctx.projectSlug) {
          error('Project not configured. Run: koda init');
          process.exit(2);
          return;
        }

        if (!ctx.apiKey) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
          return;
        }

        const client = configureClient(ctx.apiUrl, ctx.apiKey);

        await TicketsService.verify(client, ctx.projectSlug, ref, {
          body: options.comment,
          type: 'VERIFICATION',
        });

        console.log(`✓ Ticket verified successfully`);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Ticket not found: ${ref}` });
      }
    });

  ticket
    .command('assign <ref>')
    .description('Assign a ticket')
    .option('--project <slug>', 'Project slug')
    .option('--agent <agent-slug>', 'Agent to assign to')
    .option('--to <agent-slug>', 'Agent to assign to (omit for self-assign)')
    .option('--json', 'Output as JSON')
    .action(async (ref: string, options) => {
      try {
        const ctx = await resolveContext({ projectSlug: options.project });

        if (!ctx.projectSlug) {
          error('Project not configured. Run: koda init');
          process.exit(2);
          return;
        }

        if (!ctx.apiKey) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
          return;
        }

        const client = configureClient(ctx.apiUrl, ctx.apiKey);
        const agentSlug = options.agent ?? options.to ?? 'self';

        const response = await TicketsService.assign(client, ctx.projectSlug, ref, { agentSlug });
        const ticketData = unwrap(response);

        if (options.json) {
          console.log(JSON.stringify(ticketData, null, 2));
        } else {
          console.log(`✓ Ticket assigned successfully`);
        }

        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Agent or ticket not found` });
      }
    });

  ticket
    .command('start <ref>')
    .description('Start a ticket (CREATED or VERIFIED → IN_PROGRESS)')
    .option('--project <slug>', 'Project slug')
    .action(async (ref: string, options) => {
      try {
        const ctx = await resolveContext({ projectSlug: options.project });

        if (!ctx.projectSlug) {
          error('Project not configured. Run: koda init');
          process.exit(2);
          return;
        }

        if (!ctx.apiKey) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
          return;
        }

        const client = configureClient(ctx.apiUrl, ctx.apiKey);

        await TicketsService.start(client, ctx.projectSlug, ref);

        console.log(`✓ Ticket started successfully`);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Ticket not found: ${ref}` });
      }
    });

  ticket
    .command('fix <ref>')
    .description('Submit a fix for a ticket (IN_PROGRESS → VERIFY_FIX)')
    .option('--project <slug>', 'Project slug')
    .option('--comment <text>', 'Fix report comment')
    .option('--git-ref <ref>', 'Git reference (e.g. branch or commit)')
    .action(async (ref: string, options) => {
      try {
        if (!options.comment) {
          error('Comment is required');
          process.exit(3);
          return;
        }

        const ctx = await resolveContext({ projectSlug: options.project });

        if (!ctx.projectSlug) {
          error('Project not configured. Run: koda init');
          process.exit(2);
          return;
        }

        if (!ctx.apiKey) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
          return;
        }

        const client = configureClient(ctx.apiUrl, ctx.apiKey);

        const payload: { body: string; type: string; gitRef?: string } = {
          body: options.comment,
          type: 'FIX_REPORT',
        };
        if (options.gitRef) {
          payload.gitRef = options.gitRef;
        }

        await TicketsService.fix(client, ctx.projectSlug, ref, payload);

        console.log(`✓ Fix submitted successfully`);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Ticket not found: ${ref}` });
      }
    });

  ticket
    .command('verify-fix <ref>')
    .description('Verify a fix (VERIFY_FIX → CLOSED or → IN_PROGRESS)')
    .option('--project <slug>', 'Project slug')
    .option('--comment <text>', 'Review comment')
    .option('--pass', 'Mark fix as passing (closes ticket)')
    .option('--fail', 'Mark fix as failing (returns to IN_PROGRESS)')
    .action(async (ref: string, options) => {
      try {
        if (!options.comment) {
          error('Comment is required');
          process.exit(3);
          return;
        }

        const ctx = await resolveContext({ projectSlug: options.project });

        if (!ctx.projectSlug) {
          error('Project not configured. Run: koda init');
          process.exit(2);
          return;
        }

        if (!ctx.apiKey) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
          return;
        }

        const client = configureClient(ctx.apiUrl, ctx.apiKey);

        const status = options.pass ? 'closed' : 'in_progress';
        await TicketsService.verifyFix(client, ctx.projectSlug, ref, {
          body: options.comment,
          type: 'REVIEW',
          status,
        });

        console.log(`✓ Fix verification submitted successfully`);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Ticket not found: ${ref}` });
      }
    });

  ticket
    .command('close <ref>')
    .description('Close a ticket')
    .option('--project <slug>', 'Project slug')
    .action(async (ref: string, options) => {
      try {
        const ctx = await resolveContext({ projectSlug: options.project });

        if (!ctx.projectSlug) {
          error('Project not configured. Run: koda init');
          process.exit(2);
          return;
        }

        if (!ctx.apiKey) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
          return;
        }

        const client = configureClient(ctx.apiUrl, ctx.apiKey);

        await TicketsService.close(client, ctx.projectSlug, ref);

        console.log(`✓ Ticket closed successfully`);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Ticket not found: ${ref}` });
      }
    });

  ticket
    .command('reject <ref>')
    .description('Reject a ticket')
    .option('--project <slug>', 'Project slug')
    .option('--comment <text>', 'Rejection reason')
    .action(async (ref: string, options) => {
      try {
        if (!options.comment) {
          error('Comment is required');
          process.exit(3);
          return;
        }

        const ctx = await resolveContext({ projectSlug: options.project });

        if (!ctx.projectSlug) {
          error('Project not configured. Run: koda init');
          process.exit(2);
          return;
        }

        if (!ctx.apiKey) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
          return;
        }

        const client = configureClient(ctx.apiUrl, ctx.apiKey);

        await TicketsService.reject(client, ctx.projectSlug, ref, {
          body: options.comment,
          type: 'GENERAL',
        });

        console.log(`✓ Ticket rejected successfully`);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Ticket not found: ${ref}` });
      }
    });

  ticket
    .command('update <ref>')
    .description('Update a ticket')
    .option('--project <slug>', 'Project slug')
    .option('--title <title>', 'New title')
    .option('--desc <description>', 'New description')
    .option('--priority <priority>', 'New priority (LOW|MEDIUM|HIGH|CRITICAL)')
    .option('--json', 'Output as JSON')
    .action(async (ref: string, options) => {
      try {
        const ctx = await resolveContext({ projectSlug: options.project });

        if (!ctx.projectSlug) {
          error('Project not configured. Run: koda init');
          process.exit(2);
          return;
        }

        if (!ctx.apiKey) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
          return;
        }

        const client = configureClient(ctx.apiUrl, ctx.apiKey);

        const payload: { title?: string; description?: string; priority?: string } = {};
        if (options.title) payload.title = options.title;
        if (options.desc) payload.description = options.desc;
        if (options.priority) payload.priority = options.priority;

        const response = await TicketsService.update(client, ctx.projectSlug, ref, payload);
        const ticketData = unwrap(response);

        if (options.json) {
          console.log(JSON.stringify(ticketData, null, 2));
        } else {
          console.log(`✓ Ticket updated successfully`);
        }

        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Ticket not found: ${ref}` });
      }
    });

  ticket
    .command('delete <ref>')
    .description('Delete a ticket')
    .option('--project <slug>', 'Project slug')
    .option('--force', 'Confirm deletion')
    .action(async (ref: string, options) => {
      try {
        if (!options.force) {
          error(`Deletion requires --force flag.`);
          process.exit(1);
        }

        const ctx = await resolveContext({ projectSlug: options.project });

        if (!ctx.projectSlug) {
          error('Project not configured. Run: koda init');
          process.exit(2);
          return;
        }

        if (!ctx.apiKey) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
          return;
        }

        const client = configureClient(ctx.apiUrl, ctx.apiKey);

        await TicketsService.delete(client, ctx.projectSlug, ref);

        console.log(`✓ Ticket deleted successfully`);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Ticket not found: ${ref}` });
      }
    });

  ticket
    .command('link <ref>')
    .description('Link an external URL to a ticket')
    .option('--project <slug>', 'Project slug')
    .requiredOption('--url <url>', 'External URL to link')
    .option('--json', 'Output as JSON')
    .action(async (ref: string, options) => {
      try {
        const ctx = await resolveContext({ projectSlug: options.project });

        if (!ctx.projectSlug) {
          error('Project not configured. Run: koda init');
          process.exit(2);
          return;
        }

        if (!ctx.apiKey) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
          return;
        }

        const client = configureClient(ctx.apiUrl, ctx.apiKey);

        const response = await TicketLinksService.create(client, ctx.projectSlug, ref, { url: options.url });
        const linkData = unwrap(response) as TicketLink;

        if (options.json) {
          console.log(JSON.stringify(linkData, null, 2));
        } else {
          console.log(`provider: ${linkData.provider}`);
          console.log(`externalRef: ${linkData.externalRef}`);
        }

        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  ticket
    .command('unlink <ref>')
    .description('Remove an external URL link from a ticket')
    .option('--project <slug>', 'Project slug')
    .requiredOption('--url <url>', 'External URL to unlink')
    .action(async (ref: string, options) => {
      try {
        const ctx = await resolveContext({ projectSlug: options.project });

        if (!ctx.projectSlug) {
          error('Project not configured. Run: koda init');
          process.exit(2);
          return;
        }

        if (!ctx.apiKey) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
          return;
        }

        const client = configureClient(ctx.apiUrl, ctx.apiKey);

        const listResponse = await TicketLinksService.list(client, ctx.projectSlug, ref);
        const links = unwrap(listResponse) as TicketLink[];
        const match = links.find((l) => l.url === options.url);

        if (!match) {
          console.log(`No link found for ${options.url}`);
          process.exit(1);
          return;
        }

        await TicketLinksService.delete(client, ctx.projectSlug, ref, match.id);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });

  const ticketLabel = ticket.command('label').description('Manage labels on a ticket');

  ticketLabel
    .command('add <ref>')
    .description('Attach a label to a ticket')
    .option('--project <slug>', 'Project slug')
    .requiredOption('--label <id>', 'Label ID')
    .action(async (ref: string, options) => {
      try {
        const ctx = await resolveContext({ projectSlug: options.project });

        if (!ctx.projectSlug) {
          error('Project not configured. Run: koda init');
          process.exit(2);
          return;
        }

        if (!ctx.apiKey) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
          return;
        }

        const client = configureClient(ctx.apiUrl, ctx.apiKey);

        await LabelsService.addToTicket(client, ctx.projectSlug, ref, options.label);

        console.log(`✓ Label attached to ticket ${ref}`);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Ticket or label not found` });
      }
    });

  ticketLabel
    .command('remove <ref>')
    .description('Detach a label from a ticket')
    .option('--project <slug>', 'Project slug')
    .requiredOption('--label <id>', 'Label ID')
    .option('--json', 'Output as JSON')
    .action(async (ref: string, options) => {
      try {
        const ctx = await resolveContext({ projectSlug: options.project });

        if (!ctx.projectSlug) {
          error('Project not configured. Run: koda init');
          process.exit(2);
          return;
        }

        if (!ctx.apiKey) {
          error('API key or URL not configured. Run: koda login --api-key <key>');
          process.exit(2);
          return;
        }

        const client = configureClient(ctx.apiUrl, ctx.apiKey);

        await LabelsService.removeFromTicket(client, ctx.projectSlug, ref, options.label);

        console.log(`✓ Label detached from ticket ${ref}`);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Ticket or label not found` });
      }
    });
}
