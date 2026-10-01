import { Command } from 'commander';
import {
  fleetReposControllerCheck,
  fleetReposControllerCreate,
  fleetReposControllerList,
  fleetReposControllerRemove,
  projectFleetReposControllerList,
  type FleetRepoDto,
  type RepoCheckResultDto,
} from '../generated';
import { unwrap } from '../utils/api';
import { withContext } from '../utils/context';
import { handleApiError } from '../utils/error';
import { requireForce } from '../utils/force';
import { table } from '../utils/output';
import { parsePositiveInt } from '../utils/parse-positive-int';
import { ADMIN_TOKEN_HINT, type FleetPage, handleFleetValidation, pageHint, splitRepoPath } from './fleet-shared';

const PROVIDERS = ['github', 'gitlab'] as const;
type Provider = (typeof PROVIDERS)[number];

function registerAdd(repo: Command): void {
  repo
    .command('add <ownerAndName>')
    .description(`Register a repo for dispatch after koda proves it can broker git access (global admin). ${ADMIN_TOKEN_HINT}`)
    .requiredOption('--provider <provider>', 'github or gitlab')
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--json', 'Output as JSON')
    .action(async (ownerAndName: string, options: { provider: string; project?: string; json?: boolean }) => {
      const parts = splitRepoPath(ownerAndName);
      if (!parts || !(PROVIDERS as readonly string[]).includes(options.provider)) {
        return handleFleetValidation(!parts ? `Expected owner/name, got "${ownerAndName}"` : `Unknown provider "${options.provider}": github or gitlab`);
      }
      try {
        const ctx = await withContext({ projectSlug: options.project });
        const created = unwrap<FleetRepoDto>(await fleetReposControllerCreate({
          body: { projectSlug: ctx.projectSlug, provider: options.provider as Provider, owner: parts.owner, name: parts.name },
        }));
        if (options.json) console.log(JSON.stringify(created, null, 2));
        else console.log(`Registered ${created.owner}/${created.name} (${created.id}), default branch ${created.defaultBranch}`);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { forbiddenHint: ADMIN_TOKEN_HINT });
      }
    });
}

function registerList(repo: Command): void {
  repo
    .command('list')
    .description("List the project's fleet repos (--all: the whole registry, global admin)")
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--all', 'Every registered repo (global admin)')
    .option('--page <n>', 'Page number', parsePositiveInt, 1)
    .option('--size <n>', 'Page size (1-100)', parsePositiveInt, 100)
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const query = { current: options.page, size: options.size };
        let response: unknown;
        if (options.all) {
          await withContext({}, { requireProject: false });
          response = await fleetReposControllerList({ query });
        } else {
          const ctx = await withContext({ projectSlug: options.project });
          response = await projectFleetReposControllerList({ path: { slug: ctx.projectSlug }, query });
        }
        const page = unwrap<FleetPage<FleetRepoDto>>(response);
        if (options.json) {
          console.log(JSON.stringify(page, null, 2));
        } else {
          table(['ID', 'Provider', 'Repo', 'Default branch'], page.records.map((r) => [r.id, r.provider, `${r.owner}/${r.name}`, r.defaultBranch]));
          const hint = pageHint(page);
          if (hint) console.log(hint);
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, options.all ? { forbiddenHint: ADMIN_TOKEN_HINT } : undefined);
      }
    });
}

function registerRemove(repo: Command): void {
  repo
    .command('rm <repoId>')
    .description('Unregister a repo; refused while it has unfinished jobs (global admin)')
    .option('--force', 'Confirm the removal')
    .action(async (repoId: string, options: { force?: boolean }) => {
      if (!requireForce(options.force)) return;
      try {
        await withContext({}, { requireProject: false });
        await fleetReposControllerRemove({ path: { id: repoId } });
        console.log(`Removed repo ${repoId}`);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { forbiddenHint: ADMIN_TOKEN_HINT, notFoundMessage: `Repo not found: ${repoId}` });
      }
    });
}

function registerCheck(repo: Command): void {
  repo
    .command('check <repoId>')
    .description('Re-run the forge check: can koda still broker git for this repo? Exit 1 when not (global admin)')
    .option('--json', 'Output as JSON')
    .action(async (repoId: string, options: { json?: boolean }) => {
      try {
        await withContext({}, { requireProject: false });
        const result = unwrap<RepoCheckResultDto>(await fleetReposControllerCheck({ path: { id: repoId } }));
        if (options.json) console.log(JSON.stringify(result, null, 2));
        else console.log(result.reachable ? `Reachable (${result.checkedAt})` : `Unreachable: ${result.reason ?? 'unknown'} (${result.checkedAt})`);
        process.exit(result.reachable ? 0 : 1);
      } catch (err: unknown) {
        handleApiError(err, { forbiddenHint: ADMIN_TOKEN_HINT, notFoundMessage: `Repo not found: ${repoId}` });
      }
    });
}

export function registerFleetRepo(fleet: Command): void {
  const repo = fleet.command('repo');
  repo.description('Fleet repo registry');
  registerAdd(repo);
  registerList(repo);
  registerRemove(repo);
  registerCheck(repo);
}
