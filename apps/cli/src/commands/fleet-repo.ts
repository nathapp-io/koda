import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import {
  fleetReposControllerCheck,
  fleetReposControllerCreate,
  fleetReposControllerList,
  fleetReposControllerRemove,
  fleetReposControllerRotateGitlabCredentials,
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
class TokenFileValidationError extends Error {}
type Provider = (typeof PROVIDERS)[number];

async function tokenFromFile(file: string): Promise<string> {
  try {
    const content = file === '-' ? await readStdin() : await readFile(file, 'utf8');
    return content.replace(/\r?\n$/, '');
  } catch (error) {
    if (file !== '-' && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      handleFleetValidation(`Token file not found: ${file}`);
      throw new TokenFileValidationError();
    }
    throw error;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function printHumanTokenWarning(value: FleetRepoDto): void {
  if (value.gitlab?.warnings.includes('write_token_human')) {
    console.error(`Warning: GitLab write token belongs to human account ${value.gitlab.writeToken.username}.`);
  }
}

function registerAdd(repo: Command): void {
  repo
    .command('add <ownerAndName>')
    .description(`Register a repo for dispatch after koda proves it can broker git access (global admin). ${ADMIN_TOKEN_HINT}`)
    .requiredOption('--provider <provider>', 'github or gitlab')
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--host <url>', 'GitLab host URL')
    .option('--read-token-file <path|->', 'Read token file, or - for stdin')
    .option('--write-token-file <path|->', 'Write token file, or - for stdin')
    .option('--confirm-bot', 'Confirm the write token belongs to the bot account')
    .option('--json', 'Output as JSON')
    .action(async (ownerAndName: string, options: { provider: string; project?: string; host?: string; readTokenFile?: string; writeTokenFile?: string; confirmBot?: boolean; json?: boolean }) => {
      const parts = splitRepoPath(ownerAndName);
      if (!parts || !(PROVIDERS as readonly string[]).includes(options.provider)) {
        return handleFleetValidation(!parts ? `Expected owner/name, got "${ownerAndName}"` : `Unknown provider "${options.provider}": github or gitlab`);
      }
      const hasGitlabOptions = options.host !== undefined || options.readTokenFile !== undefined || options.writeTokenFile !== undefined || options.confirmBot === true;
      if (options.provider === 'github' && hasGitlabOptions) return handleFleetValidation('GitLab-only options cannot be used with --provider github');
      try {
        const ctx = await withContext({ projectSlug: options.project });
        let gitlabFields = {};
        if (options.provider === 'gitlab') {
          const readFile = options.readTokenFile;
          const writeFile = options.writeTokenFile;
          if (!readFile || !writeFile) return handleFleetValidation('GitLab registration requires --read-token-file and --write-token-file');
          gitlabFields = { ...(options.host ? { host: options.host } : {}), readToken: await tokenFromFile(readFile), writeToken: await tokenFromFile(writeFile), ...(options.confirmBot ? { confirmBotAccount: true } : {}) };
        }
        const body = { projectSlug: ctx.projectSlug, provider: options.provider as Provider, owner: parts.owner, name: parts.name, ...gitlabFields };
        const created = unwrap<FleetRepoDto>(await fleetReposControllerCreate({ body }));
        printHumanTokenWarning(created);
        if (options.json) console.log(JSON.stringify(created, null, 2));
        else console.log(`Registered ${created.owner}/${created.name} (${created.id}), default branch ${created.defaultBranch}`);
        process.exit(0);
      } catch (err: unknown) {
        if (err instanceof TokenFileValidationError) return;
        handleApiError(err, { forbiddenHint: ADMIN_TOKEN_HINT });
      }
    });
}

function registerCredentials(repo: Command): void {
  repo.command('credentials <repoId>').description('Rotate GitLab repo credentials (global admin)')
    .option('--read-token-file <path|->', 'Read token file, or - for stdin')
    .option('--write-token-file <path|->', 'Write token file, or - for stdin')
    .option('--confirm-bot', 'Confirm the write token belongs to the bot account')
    .option('--json', 'Output as JSON')
    .action(async (repoId: string, options: { readTokenFile?: string; writeTokenFile?: string; confirmBot?: boolean; json?: boolean }) => {
      if (!options.readTokenFile && !options.writeTokenFile) return handleFleetValidation('Provide --read-token-file or --write-token-file');
      try {
        await withContext({}, { requireProject: false });
        const body = { ...(options.readTokenFile ? { readToken: await tokenFromFile(options.readTokenFile) } : {}), ...(options.writeTokenFile ? { writeToken: await tokenFromFile(options.writeTokenFile) } : {}), ...(options.confirmBot ? { confirmBotAccount: true } : {}) };
        const updated = unwrap<FleetRepoDto>(await fleetReposControllerRotateGitlabCredentials({ path: { id: repoId }, body }));
        printHumanTokenWarning(updated);
        if (options.json) console.log(JSON.stringify(updated, null, 2));
        else console.log(`Updated GitLab credentials for ${updated.owner}/${updated.name} (${updated.id})`);
        process.exit(0);
      } catch (err: unknown) { if (err instanceof TokenFileValidationError) return; handleApiError(err, { forbiddenHint: ADMIN_TOKEN_HINT }); }
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
  registerCredentials(repo);
  registerList(repo);
  registerRemove(repo);
  registerCheck(repo);
}
