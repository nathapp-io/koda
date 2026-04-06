import { Command } from 'commander';
import { resolveContext } from '../config';
import { OpenAPI } from '../generated/core/OpenAPI';
import {
  ticketsControllerCreate,
  ticketsControllerFindAll,
  ticketsControllerFindByRef,
  ticketsControllerUpdate,
  ticketsControllerSoftDelete,
  ticketsControllerAssign,
  ticketsControllerVerify,
  ticketsControllerStart,
  ticketsControllerFix,
  ticketsControllerVerifyFix,
  ticketsControllerClose,
  ticketsControllerReject,
  ticketLinksControllerCreate,
  ticketLinksControllerFindAll,
  ticketLinksControllerRemove,
  labelsControllerAssignLabelFromHttp,
  labelsControllerRemoveLabelFromHttp,
} from '../generated';
import { table } from '../utils/output';
import { unwrap } from '../utils/api';
import { handleApiError } from '../utils/error';

type TicketRow = {
  ref?: string;
  number?: number;
  type: string;
  priority?: string;
  status: string;
  assignee?: { name?: string } | null;
  title: string;
};

type TicketDetail = TicketRow & {
  id: string;
  description?: string;
  createdAt: string;
  updatedAt?: string;
  comments?: Array<{ author?: { name?: string }; type: string; body: string }>;
  links?: TicketLink[];
};

type TicketLink = { id: string; url: string; provider: string; externalRef: string };

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
          handleApiError(new Error('Project not configured. Run: koda init'), { configError: true });
        }

        if (!ctx.apiKey) {
          handleApiError(new Error('API key or URL not configured. Run: koda login --api-key <key>'), { configError: true });
        }

        if (!options.type || !options.title) {
          handleApiError(new Error('Missing required options: --type and --title are required'), { validationError: true });
        }

        const validTypes = ['BUG', 'ENHANCEMENT', 'TASK', 'QUESTION'];
        if (!validTypes.includes(options.type)) {
          handleApiError(new Error(`Invalid type ${options.type}. Valid values: ${validTypes.join(', ')}`), { validationError: true });
        }

        const validPriorities = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
        if (options.priority && !validPriorities.includes(options.priority)) {
          handleApiError(new Error(`Invalid priority ${options.priority}. Valid values: ${validPriorities.join(', ')}`), { validationError: true });
        }

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = ctx.apiKey;

        const response = await ticketsControllerCreate({
          slug: ctx.projectSlug,
          requestBody: {
            type: options.type as 'BUG' | 'ENHANCEMENT' | 'TASK' | 'QUESTION',
            title: options.title,
            description: options.desc,
            priority: options.priority,
          },
        });
        const ticketData = unwrap<{ ref?: string; number?: number }>(response);

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
          handleApiError(new Error('Project not configured. Run: koda init'), { configError: true });
        }

        if (!ctx.apiKey) {
          handleApiError(new Error('API key or URL not configured. Run: koda login --api-key <key>'), { configError: true });
        }

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = ctx.apiKey;

        const response = await ticketsControllerFindAll({
          slug: ctx.projectSlug,
          status: options.status,
          type: options.type,
          priority: options.priority,
          assignedTo: options.assignedTo,
          unassigned: options.unassigned ? true : undefined,
          limit: parseInt(options.limit, 10),
          page: parseInt(options.page, 10),
        });
        const data = unwrap<{ items?: TicketRow[] } | TicketRow[]>(response);
        const items: TicketRow[] = Array.isArray(data) ? data : ((data as { items?: TicketRow[] }).items ?? []);

        if (options.json) {
          console.log(JSON.stringify(items, null, 2));
        } else {
          const rows = items.map((t) => [
            String(t.ref ?? `KODA-${t.number}`),
            String(t.type),
            String(t.priority || ''),
            String(t.status),
            String(t.assignee?.name || '—'),
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
          handleApiError(new Error('Project not configured. Run: koda init'), { configError: true });
        }

        if (!ctx.apiKey) {
          handleApiError(new Error('API key or URL not configured. Run: koda login --api-key <key>'), { configError: true });
        }

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = ctx.apiKey;

        const response = await ticketsControllerFindAll({
          slug: ctx.projectSlug,
          status: options.status,
          assignedTo: 'self',
        });
        const data = unwrap<{ items?: TicketRow[] } | TicketRow[]>(response);
        const items: TicketRow[] = Array.isArray(data) ? data : ((data as { items?: TicketRow[] }).items ?? []);

        if (options.json) {
          console.log(JSON.stringify(items, null, 2));
        } else {
          const rows = items.map((t) => [
            String(t.ref ?? `KODA-${t.number}`),
            String(t.type),
            String(t.priority || ''),
            String(t.status),
            String(t.assignee?.name || '—'),
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
          handleApiError(new Error('Project not configured. Run: koda init'), { configError: true });
        }

        if (!ctx.apiKey) {
          handleApiError(new Error('API key or URL not configured. Run: koda login --api-key <key>'), { configError: true });
        }

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = ctx.apiKey;

        const response = await ticketsControllerFindByRef({ slug: ctx.projectSlug, ref });
        const ticketData = unwrap<TicketDetail>(response);

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
              console.log(`  - ${author} (${comment.type}): ${comment.body}`);
            }
          }

          if (ticketData.links && ticketData.links.length > 0) {
            console.log(`\nLinks:`);
            for (const link of ticketData.links) {
              console.log(`  - ${link.url} (${link.provider})${link.externalRef ? ` [${link.externalRef}]` : ''}`);
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
    .option('--json', 'Output as JSON')
    .action(async (ref: string, options) => {
      try {
        if (!options.comment) {
          handleApiError(new Error('Comment is required'), { validationError: true });
        }

        const ctx = await resolveContext({ projectSlug: options.project });

        if (!ctx.projectSlug) {
          handleApiError(new Error('Project not configured. Run: koda init'), { configError: true });
        }

        if (!ctx.apiKey) {
          handleApiError(new Error('API key or URL not configured. Run: koda login --api-key <key>'), { configError: true });
        }

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = ctx.apiKey;

        await ticketsControllerVerify({
          slug: ctx.projectSlug,
          ref,
          requestBody: { body: options.comment },
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
          handleApiError(new Error('Project not configured. Run: koda init'), { configError: true });
        }

        if (!ctx.apiKey) {
          handleApiError(new Error('API key or URL not configured. Run: koda login --api-key <key>'), { configError: true });
        }

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = ctx.apiKey;

        const response = await ticketsControllerAssign({ slug: ctx.projectSlug, ref });
        const ticketData = unwrap<TicketRow>(response);

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
    .option('--json', 'Output as JSON')
    .action(async (ref: string, options) => {
      try {
        const ctx = await resolveContext({ projectSlug: options.project });

        if (!ctx.projectSlug) {
          handleApiError(new Error('Project not configured. Run: koda init'), { configError: true });
        }

        if (!ctx.apiKey) {
          handleApiError(new Error('API key or URL not configured. Run: koda login --api-key <key>'), { configError: true });
        }

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = ctx.apiKey;

        await ticketsControllerStart({ slug: ctx.projectSlug, ref });
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
    .option('--json', 'Output as JSON')
    .action(async (ref: string, options) => {
      try {
        if (!options.comment) {
          handleApiError(new Error('Comment is required'), { validationError: true });
        }

        const ctx = await resolveContext({ projectSlug: options.project });

        if (!ctx.projectSlug) {
          handleApiError(new Error('Project not configured. Run: koda init'), { configError: true });
        }

        if (!ctx.apiKey) {
          handleApiError(new Error('API key or URL not configured. Run: koda login --api-key <key>'), { configError: true });
        }

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = ctx.apiKey;

        await ticketsControllerFix({
          slug: ctx.projectSlug,
          ref,
          requestBody: { body: options.comment },
        });
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
    .option('--json', 'Output as JSON')
    .action(async (ref: string, options) => {
      try {
        if (!options.comment) {
          handleApiError(new Error('Comment is required'), { validationError: true });
        }

        if (!options.pass && !options.fail) {
          handleApiError(new Error('Specify exactly one of --pass or --fail'), { validationError: true });
        }

        if (options.pass && options.fail) {
          handleApiError(new Error('Specify only one of --pass or --fail'), { validationError: true });
        }

        const ctx = await resolveContext({ projectSlug: options.project });

        if (!ctx.projectSlug) {
          handleApiError(new Error('Project not configured. Run: koda init'), { configError: true });
        }

        if (!ctx.apiKey) {
          handleApiError(new Error('API key or URL not configured. Run: koda login --api-key <key>'), { configError: true });
        }

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = ctx.apiKey;

        await ticketsControllerVerifyFix({
          slug: ctx.projectSlug,
          ref,
          requestBody: { body: options.comment },
        });

        // The generated client currently does not expose the approve query param.
        // Preserve expected CLI semantics: --pass should conclude with CLOSED.
        if (options.pass) {
          await ticketsControllerClose({ slug: ctx.projectSlug, ref });
          console.log(`✓ Fix verified and ticket closed successfully`);
        } else {
          console.log(`✓ Fix verification submitted successfully`);
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Ticket not found: ${ref}` });
      }
    });

  ticket
    .command('close <ref>')
    .description('Close a ticket')
    .option('--project <slug>', 'Project slug')
    .option('--json', 'Output as JSON')
    .action(async (ref: string, options) => {
      try {
        const ctx = await resolveContext({ projectSlug: options.project });

        if (!ctx.projectSlug) {
          handleApiError(new Error('Project not configured. Run: koda init'), { configError: true });
        }

        if (!ctx.apiKey) {
          handleApiError(new Error('API key or URL not configured. Run: koda login --api-key <key>'), { configError: true });
        }

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = ctx.apiKey;

        await ticketsControllerClose({ slug: ctx.projectSlug, ref });
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
    .option('--json', 'Output as JSON')
    .action(async (ref: string, options) => {
      try {
        if (!options.comment) {
          handleApiError(new Error('Comment is required'), { validationError: true });
        }

        const ctx = await resolveContext({ projectSlug: options.project });

        if (!ctx.projectSlug) {
          handleApiError(new Error('Project not configured. Run: koda init'), { configError: true });
        }

        if (!ctx.apiKey) {
          handleApiError(new Error('API key or URL not configured. Run: koda login --api-key <key>'), { configError: true });
        }

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = ctx.apiKey;

        await ticketsControllerReject({
          slug: ctx.projectSlug,
          ref,
          requestBody: { body: options.comment },
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
          handleApiError(new Error('Project not configured. Run: koda init'), { configError: true });
        }

        if (!ctx.apiKey) {
          handleApiError(new Error('API key or URL not configured. Run: koda login --api-key <key>'), { configError: true });
        }

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = ctx.apiKey;

        const requestBody: { title?: string; description?: string; priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' } = {};
        if (options.title) requestBody.title = options.title;
        if (options.desc) requestBody.description = options.desc;
        if (options.priority) requestBody.priority = options.priority;

        const response = await ticketsControllerUpdate({ slug: ctx.projectSlug, ref, requestBody });
        const ticketData = unwrap<TicketRow>(response);

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
          handleApiError(new Error('Deletion requires --force flag.'), { validationError: true });
        }

        const ctx = await resolveContext({ projectSlug: options.project });

        if (!ctx.projectSlug) {
          handleApiError(new Error('Project not configured. Run: koda init'), { configError: true });
        }

        if (!ctx.apiKey) {
          handleApiError(new Error('API key or URL not configured. Run: koda login --api-key <key>'), { configError: true });
        }

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = ctx.apiKey;

        await ticketsControllerSoftDelete({ slug: ctx.projectSlug, ref });

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
          handleApiError(new Error('Project not configured. Run: koda init'), { configError: true });
        }

        if (!ctx.apiKey) {
          handleApiError(new Error('API key or URL not configured. Run: koda login --api-key <key>'), { configError: true });
        }

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = ctx.apiKey;

        const response = await ticketLinksControllerCreate({
          slug: ctx.projectSlug,
          ref,
          requestBody: { url: options.url },
        });
        const linkData = unwrap<TicketLink>(response);

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
          handleApiError(new Error('Project not configured. Run: koda init'), { configError: true });
        }

        if (!ctx.apiKey) {
          handleApiError(new Error('API key or URL not configured. Run: koda login --api-key <key>'), { configError: true });
        }

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = ctx.apiKey;

        const listResponse = await ticketLinksControllerFindAll({ slug: ctx.projectSlug, ref });
        const links = unwrap<TicketLink[]>(listResponse);
        const match = links.find((l) => l.url === options.url);

        if (!match) {
          console.log(`No link found for ${options.url}`);
          process.exit(1);
        }

        await ticketLinksControllerRemove({ slug: ctx.projectSlug, ref, linkId: match.id });
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
          handleApiError(new Error('Project not configured. Run: koda init'), { configError: true });
        }

        if (!ctx.apiKey) {
          handleApiError(new Error('API key or URL not configured. Run: koda login --api-key <key>'), { configError: true });
        }

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = ctx.apiKey;

        await labelsControllerAssignLabelFromHttp({
          slug: ctx.projectSlug,
          ref,
          requestBody: { labelId: options.label },
        });

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
          handleApiError(new Error('Project not configured. Run: koda init'), { configError: true });
        }

        if (!ctx.apiKey) {
          handleApiError(new Error('API key or URL not configured. Run: koda login --api-key <key>'), { configError: true });
        }

        OpenAPI.BASE = ctx.apiUrl.replace(/\/api\/?$/, '');
        OpenAPI.TOKEN = ctx.apiKey;

        await labelsControllerRemoveLabelFromHttp({
          slug: ctx.projectSlug,
          ref,
          labelId: options.label,
        });
        console.log(`✓ Label detached from ticket ${ref}`);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Ticket or label not found` });
      }
    });
}
