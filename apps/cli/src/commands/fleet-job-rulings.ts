import { Command } from 'commander';
import { fleetRulingsControllerCreate, fleetRulingsControllerList, type FleetPrRulingDto } from '../generated';
import { unwrap } from '../utils/api';
import { withContext } from '../utils/context';
import { handleApiError } from '../utils/error';
import { table } from '../utils/output';

interface Options { project?: string; json?: boolean }

function registerList(job: Command): void {
  job.command('rulings <jobId>')
    .description('List rulings recorded on a fleet job')
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--json', 'Output as JSON')
    .action(async (jobId: string, options: Options) => {
      try {
        const { projectSlug: slug } = await withContext({ projectSlug: options.project });
        const rulings = unwrap<FleetPrRulingDto[]>(await fleetRulingsControllerList({ path: { slug, id: jobId } }));
        if (options.json) console.log(JSON.stringify(rulings, null, 2));
        else table(['Item', 'Disposition', 'State', 'Actor', 'Skip reason'], rulings.map((r) => [r.itemId, r.disposition, r.state, r.actorType, r.skipReason ?? '-']));
        process.exit(0);
      } catch (err: unknown) { handleApiError(err); }
    });
}

function registerCreate(job: Command): void {
  job.command('rule <jobId> <itemId> <text>')
    .description('Record a ruling on an open fleet job item')
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .action(async (jobId: string, itemId: string, text: string, options: Options) => {
      if (!text.trim()) return handleApiError(new Error('Ruling text must not be empty'), { validationError: true });
      try {
        const { projectSlug: slug } = await withContext({ projectSlug: options.project });
        const response = await fleetRulingsControllerCreate({ path: { slug, id: jobId }, body: { itemId, text } });
        const ruling = unwrap<FleetPrRulingDto>(response);
        console.log(`Ruling recorded: ${ruling.id}`);
        process.exit(0);
      } catch (err: unknown) { handleApiError(err); }
    });
}

export function registerFleetJobRulings(job: Command): void {
  registerList(job);
  registerCreate(job);
}
