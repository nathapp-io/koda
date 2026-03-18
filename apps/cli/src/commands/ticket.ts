import { Command } from 'commander';

export function ticketCommand(program: Command): void {
  const ticket = program.command('ticket');

  ticket.description('Manage tickets');

  // Placeholder subcommands - full implementation in future sprint
  ticket
    .command('list')
    .description('List tickets')
    .option('--project <slug>', 'Project slug')
    .option('--status <status>', 'Filter by status')
    .option('--json', 'Output as JSON')
    .action(() => {
      console.log('ticket list command placeholder');
      process.exit(0);
    });

  ticket
    .command('show <ref>')
    .description('Show ticket details')
    .option('--json', 'Output as JSON')
    .action((ref: string) => {
      console.log(`ticket show ${ref} placeholder`);
      process.exit(0);
    });

  ticket
    .command('create')
    .description('Create a new ticket')
    .requiredOption('--project <slug>', 'Project slug')
    .requiredOption('--type <type>', 'Ticket type (bug|enhancement)')
    .requiredOption('--title <title>', 'Ticket title')
    .option('--desc <description>', 'Ticket description')
    .option('--priority <priority>', 'Priority (low|medium|high|critical)')
    .option('--json', 'Output as JSON')
    .action(() => {
      console.log('ticket create placeholder');
      process.exit(0);
    });

  ticket
    .command('mine')
    .description('List tickets assigned to me')
    .option('--project <slug>', 'Filter by project')
    .option('--status <status>', 'Filter by status')
    .option('--json', 'Output as JSON')
    .action(() => {
      console.log('ticket mine placeholder');
      process.exit(0);
    });

  ticket
    .command('verify <ref>')
    .description('Verify a ticket (CREATED → VERIFIED)')
    .requiredOption('--comment <text>', 'Verification comment')
    .action((ref: string) => {
      console.log(`ticket verify ${ref} placeholder`);
      process.exit(0);
    });

  ticket
    .command('assign <ref>')
    .description('Assign a ticket')
    .option('--to <agent-slug>', 'Agent to assign to (omit for self-assign)')
    .action((ref: string) => {
      console.log(`ticket assign ${ref} placeholder`);
      process.exit(0);
    });

  ticket
    .command('start <ref>')
    .description('Start a ticket (VERIFIED → IN_PROGRESS)')
    .action((ref: string) => {
      console.log(`ticket start ${ref} placeholder`);
      process.exit(0);
    });

  ticket
    .command('fix <ref>')
    .description('Submit a fix for a ticket (IN_PROGRESS → VERIFY_FIX)')
    .requiredOption('--comment <text>', 'Fix report comment')
    .option('--git-ref <ref>', 'Git reference (e.g. v1.0:src/auth.ts:42)')
    .action((ref: string) => {
      console.log(`ticket fix ${ref} placeholder`);
      process.exit(0);
    });

  ticket
    .command('verify-fix <ref>')
    .description('Verify a fix (VERIFY_FIX → CLOSED or → IN_PROGRESS)')
    .requiredOption('--comment <text>', 'Review comment')
    .option('--pass', 'Mark fix as passing (closes ticket)')
    .option('--fail', 'Mark fix as failing (returns to IN_PROGRESS)')
    .action((ref: string) => {
      console.log(`ticket verify-fix ${ref} placeholder`);
      process.exit(0);
    });

  ticket
    .command('close <ref>')
    .description('Close a ticket')
    .action((ref: string) => {
      console.log(`ticket close ${ref} placeholder`);
      process.exit(0);
    });

  ticket
    .command('reject <ref>')
    .description('Reject a ticket')
    .requiredOption('--comment <text>', 'Rejection reason')
    .action((ref: string) => {
      console.log(`ticket reject ${ref} placeholder`);
      process.exit(0);
    });
}
