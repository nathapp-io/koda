import { Command } from 'commander';
import {
  enrollmentsControllerCreate,
  runnersControllerList,
  runnersControllerUpdate,
  type EnrollmentCreatedDto,
  type RunnerDto,
} from '../generated';
import { unwrap } from '../utils/api';
import { withContext } from '../utils/context';
import { handleApiError } from '../utils/error';
import { table } from '../utils/output';
import { parsePositiveInt } from '../utils/parse-positive-int';
import { ADMIN_TOKEN_HINT, ago, type FleetPage, handleFleetValidation, pageHint } from './fleet-shared';

const LABEL = /^[a-z0-9][a-z0-9._-]{0,31}$/; // UpdateRunnerDto / CreateEnrollmentDto LABEL_PATTERN

const collect = (value: string, previous: string[]): string[] => [...previous, value];

function naxVersion(r: RunnerDto): string {
  const nax = (r.capabilities as { nax?: { version?: unknown } }).nax;
  return typeof nax?.version === 'string' ? nax.version : '-';
}

function runnerRow(r: RunnerDto): string[] {
  return [
    r.name, r.id, r.online ? 'yes' : 'no', r.enabled ? 'yes' : 'no', r.labels.join(','), String(r.capacity),
    naxVersion(r), ago(r.lastSeenAt), ago(r.bootedAt),
  ];
}

function registerList(runner: Command): void {
  runner
    .command('list')
    .description('List runners with online state, labels, capacity and boot age')
    .option('--page <n>', 'Page number', parsePositiveInt, 1)
    .option('--size <n>', 'Page size (1-100)', parsePositiveInt, 100)
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        await withContext({}, { requireProject: false });
        const page = unwrap<FleetPage<RunnerDto>>(await runnersControllerList({ query: { current: options.page, size: options.size } }));
        if (options.json) {
          console.log(JSON.stringify(page, null, 2));
        } else {
          table(['Name', 'ID', 'Online', 'Enabled', 'Labels', 'Cap', 'nax', 'Last seen', 'Boot age'], page.records.map(runnerRow));
          const hint = pageHint(page);
          if (hint) console.log(hint);
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { forbiddenHint: ADMIN_TOKEN_HINT });
      }
    });
}

function registerToggle(runner: Command, name: 'enable' | 'disable'): void {
  const enabled = name === 'enable';
  runner
    .command(`${name} <runnerId>`)
    .description(enabled ? 'Let placement use the runner again' : 'Drain the runner: running jobs finish, no new jobs')
    .option('--json', 'Output as JSON')
    .action(async (runnerId: string, options) => {
      try {
        await withContext({}, { requireProject: false });
        const updated = unwrap<RunnerDto>(await runnersControllerUpdate({ path: { id: runnerId }, body: { enabled } }));
        if (options.json) console.log(JSON.stringify(updated, null, 2));
        else console.log(`Runner ${updated.name} ${enabled ? 'enabled' : 'disabled'}`);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { forbiddenHint: ADMIN_TOKEN_HINT, notFoundMessage: `Runner not found: ${runnerId}` });
      }
    });
}

function registerEnrollToken(runner: Command): void {
  runner
    .command('enroll-token')
    .description('Issue a single-use enrollment token (shown once, valid 24h by default)')
    .option('--label <label>', 'Label preset on the enrolling runner (repeatable)', collect, [] as string[])
    .option('--json', 'Output as JSON')
    .action(async (options: { label: string[]; json?: boolean }) => {
      const bad = options.label.find((l) => !LABEL.test(l));
      if (bad !== undefined) {
        return handleFleetValidation(`Invalid label "${bad}": lowercase letters, digits, . _ -; at most 32 characters`);
      }
      try {
        const ctx = await withContext({}, { requireProject: false });
        const created = unwrap<EnrollmentCreatedDto>(await enrollmentsControllerCreate({ body: { labels: options.label } }));
        if (options.json) {
          console.log(JSON.stringify(created, null, 2));
        } else {
          const server = ctx.apiUrl.replace(/\/api\/?$/, '');
          console.log(`Token (shown once): ${created.token}`);
          console.log(`Expires: ${created.expiresAt}`);
          console.log(`On the runner machine: koda-runner enroll --server ${server} --token ${created.token}`);
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { forbiddenHint: ADMIN_TOKEN_HINT });
      }
    });
}

export function registerFleetRunner(fleet: Command): void {
  const runner = fleet.command('runner');
  runner.description(`Fleet runners (global admin). ${ADMIN_TOKEN_HINT}`);
  registerList(runner);
  registerToggle(runner, 'enable');
  registerToggle(runner, 'disable');
  registerEnrollToken(runner);
}
