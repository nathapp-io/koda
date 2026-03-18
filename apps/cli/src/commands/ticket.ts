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
    .action((ref: string) => {
      console.log(`ticket show ${ref} placeholder`);
      process.exit(0);
    });
}
