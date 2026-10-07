import { Command } from 'commander';
import { projectRepoConfigControllerList, projectRepoConfigControllerSubmitDrift, type DispatchResultDto } from '../generated';
import { unwrap } from '../utils/api';
import { withContext } from '../utils/context';
import { handleApiError } from '../utils/error';
import { table } from '../utils/output';

interface NaxFileList {
  baseSha: string;
  defaultBranch: string;
  files: Array<{ path: string; size: number; blobSha: string; group: string }>;
}

function registerNaxFiles(fleet: Command): void {
  fleet
    .command('nax-files <repoId>')
    .description("List a fleet repo's editable nax files on its default branch (S3)")
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--json', 'Output as JSON')
    .action(async (repoId: string, options: { project?: string; json?: boolean }) => {
      try {
        const ctx = await withContext({ projectSlug: options.project });
        const list = unwrap<NaxFileList>(await projectRepoConfigControllerList({ path: { slug: ctx.projectSlug, repoId } }));
        if (options.json) {
          console.log(JSON.stringify(list, null, 2));
        } else {
          console.log(`${list.defaultBranch} @ ${list.baseSha.slice(0, 12)}`);
          table(['Group', 'Path', 'Size'], list.files.map((f) => [f.group, f.path, String(f.size)]));
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Repo not found in this project: ${repoId}` });
      }
    });
}

function registerDriftCheck(fleet: Command): void {
  fleet
    .command('drift-check <repoId>')
    .description('Queue a drift check: would `nax generate` change the generated agent files? (DEVELOPER+)')
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--json', 'Output as JSON')
    .action(async (repoId: string, options: { project?: string; json?: boolean }) => {
      try {
        const ctx = await withContext({ projectSlug: options.project });
        // S3 §4.2 (B1): the submit answers like dispatch, `{ job, placement }`.
        const result = unwrap<DispatchResultDto>(await projectRepoConfigControllerSubmitDrift({ path: { slug: ctx.projectSlug, repoId } }));
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          const placed = result.placement.assigned ? `assigned to ${result.placement.runnerId}` : 'waiting for a runner';
          console.log(`Queued drift check ${result.job.id} (${result.job.state}, ${placed}); follow it with: koda fleet job show ${result.job.id}`);
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Repo not found in this project: ${repoId}` });
      }
    });
}

export function registerFleetConfig(fleet: Command): void {
  registerNaxFiles(fleet);
  registerDriftCheck(fleet);
}
