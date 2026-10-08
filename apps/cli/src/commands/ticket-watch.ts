import { Command } from 'commander';
import { ticketWatchControllerUnwatch, ticketWatchControllerWatch } from '../generated';
import { unwrap } from '../utils/api';
import { handleApiError } from '../utils/error';
import { withContext } from '../utils/context';

interface WatchState {
  watching: boolean;
  count: number;
}

/** S4a §3: `koda ticket watch|unwatch <ref>` (user access token; unwatch keeps assignments and mentions). */
export function registerTicketWatch(ticket: Command): void {
  for (const [name, call, verb] of [
    ['watch', ticketWatchControllerWatch, 'Watching'],
    ['unwatch', ticketWatchControllerUnwatch, 'Stopped watching'],
  ] as const) {
    ticket
      .command(`${name} <ref>`)
      .description(name === 'watch' ? 'Receive activity notifications for a ticket' : 'Stop activity notifications for a ticket (assignments and mentions still notify)')
      .option('--project <slug>', 'Project slug')
      .option('--json', 'Output as JSON')
      .action(async (ref: string, options) => {
        try {
          const ctx = await withContext({ projectSlug: options.project });
          const state = unwrap<WatchState>(await call({ path: { slug: ctx.projectSlug, ref } }));
          if (options.json) console.log(JSON.stringify(state, null, 2));
          else console.log(`${verb} ${ref} (${state.count} watching)`);
          process.exit(0);
        } catch (err: unknown) {
          handleApiError(err, { notFoundMessage: `Ticket not found: ${ref}` });
        }
      });
  }
}
