import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

async function listJsonl(dir: string, skip: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith('.jsonl') && name !== skip);
  } catch {
    return [];
  }
}

async function newest(dir: string, names: string[]): Promise<string | null> {
  if (names.length === 0) return null;
  if (names.length === 1) return join(dir, names[0]);
  const timed = await Promise.all(names.map(async (name) => ({ name, mtime: (await stat(join(dir, name))).mtimeMs })));
  timed.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
  return join(dir, timed[0].name);
}

/**
 * During the run the log is `<out>/features/<f>/runs/<logRunId>.jsonl` (`latest.jsonl` is symlinked only after
 * the run returns), and a fresh output dir holds exactly one run; the newest wins if that ever fails.
 */
export async function findRunLog(outDir: string, feature: string): Promise<string | null> {
  const dir = join(outDir, 'features', feature, 'runs');
  return newest(dir, await listJsonl(dir, 'latest.jsonl'));
}

export const runLogId = (path: string): string => basename(path, '.jsonl');

export async function findCostRunId(outDir: string): Promise<string | null> {
  const dir = join(outDir, 'cost');
  const path = await newest(dir, await listJsonl(dir, ''));
  return path ? runLogId(path) : null;
}
