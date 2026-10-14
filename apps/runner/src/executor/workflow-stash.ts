import { copyFile, lstat, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { featureDirFor } from '../paths/safe-segment';
import { findWorkflowResult } from '../verdict/workflow-result';

/** Files larger than this are never stashed (mirrors the 1 MiB read cap in workflow-result.ts). */
const MAX_STASH_BYTES = 1024 * 1024;

export type WorkflowStashName = 'result.json' | 'feature-report.md' | 'decisions.jsonl';

async function copyableFile(path: string, opts: { minMtimeMs?: number } = {}): Promise<boolean> {
  let st;
  try {
    st = await lstat(path);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  if (st.size > MAX_STASH_BYTES) return false;
  if (opts.minMtimeMs !== undefined && !(st.mtimeMs >= opts.minMtimeMs)) return false;
  return true;
}

/**
 * Copies a workflow RUN's result files out of the checkout into `<jobDir>/workflow/` so the bundle can carry them.
 * Mirrors `stashPlanOutputs`: copy into the job dir, never commit. Never writes inside `repoDir` and never runs git.
 * Returns the names copied; empty (and no folder created) when there is no result.
 */
export async function stashWorkflowOutputs(
  repoDir: string,
  jobDir: string,
  feature: string,
  sinceMs: number,
): Promise<readonly WorkflowStashName[]> {
  const featureDir = featureDirFor(repoDir, feature);
  const found = await findWorkflowResult(featureDir, sinceMs).catch(() => null);
  if (!found) return [];
  const candidates: { readonly name: WorkflowStashName; readonly from: string; readonly minMtimeMs?: number }[] = [
    { name: 'result.json', from: join(found.runDir, 'result.json') },
    { name: 'feature-report.md', from: join(found.runDir, 'feature-report.md') },
    { name: 'decisions.jsonl', from: join(featureDir, 'decisions.jsonl'), minMtimeMs: sinceMs },
  ];
  const ready: typeof candidates = [];
  for (const candidate of candidates) {
    const opts = candidate.minMtimeMs === undefined ? {} : { minMtimeMs: candidate.minMtimeMs };
    if (await copyableFile(candidate.from, opts)) ready.push(candidate);
  }
  if (ready.length === 0) return [];
  const outDir = join(jobDir, 'workflow');
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const copied: WorkflowStashName[] = [];
  for (const candidate of ready) {
    try {
      await copyFile(candidate.from, join(outDir, candidate.name));
      copied.push(candidate.name);
    } catch {
      continue;
    }
  }
  if (copied.length === 0) {
    await rm(outDir, { recursive: true, force: true });
    return [];
  }
  return copied;
}
