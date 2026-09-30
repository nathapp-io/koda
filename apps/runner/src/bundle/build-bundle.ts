import { mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { FleetJobKindName } from '@nathapp/fleet-protocol';

export interface BundleFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  /** Names left out of the archive because the list file cannot express them (D68). */
  readonly skipped?: readonly string[];
}

const isPromptAudit = (name: string): boolean => name === 'prompt-audit';

/** Files and symlinks under `dir`, never following links, skipping any `prompt-audit` directory or file. */
async function walk(dir: string, prefix: string): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try {
    entries = await readdir(join(dir), { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (isPromptAudit(entry.name)) continue;
    const rel = posix.join(prefix, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(join(dir, entry.name), rel)));
    else found.push(rel);
  }
  return found;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

/** The `-T` list is one name per line and GNU tar reads backslash escapes in it (D68): such names are left out. */
const isListSafe = (name: string): boolean => !/[\n\r\\]/.test(name);

/** D27: nax-out minus prompt-audit, stdout and stderr, and for PLAN the plan logs. Sorted; unsafe names reported (D68). */
export async function collectBundleEntries(jobDir: string, command: FleetJobKindName): Promise<{ entries: string[]; skipped: string[] }> {
  const all = await walk(join(jobDir, 'nax-out'), 'nax-out');
  for (const name of ['nax.stdout', 'nax.stderr']) if (await exists(join(jobDir, name))) all.push(name);
  if (command === 'PLAN') {
    const logs = (await readdir(join(jobDir, 'plan-logs')).catch(() => [] as string[])).filter((n) => n.endsWith('.jsonl'));
    all.push(...logs.map((n) => `plan-logs/${n}`));
  }
  return { entries: all.filter(isListSafe).sort(), skipped: all.filter((name) => !isListSafe(name)).sort() };
}

export async function listBundleEntries(jobDir: string, command: FleetJobKindName): Promise<string[]> {
  return (await collectBundleEntries(jobDir, command)).entries;
}

/**
 * D68: GNU tar exits 1 with `file changed as we read it` when a live writer (a nax still flushing a log) touches a file
 * mid-read; the archive is complete. Anything else on exit 1, and every higher code, is a real failure.
 */
export function isBenignTarExit(code: number, stderr: string): boolean {
  if (code === 0) return true;
  const lines = stderr.split('\n').map((line) => line.trim()).filter(Boolean);
  return code === 1 && lines.length > 0 && lines.every((line) => /: file changed as we read it$/.test(line));
}

export async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest('hex');
}

/** System `tar -czf out -C <jobDir> -T <list>`: bsdtar and GNU tar both accept it; nothing is held in memory. */
export async function buildBundle(input: { jobDir: string; command: FleetJobKindName }): Promise<BundleFile> {
  const { jobDir } = input;
  await mkdir(jobDir, { recursive: true });
  const { entries, skipped } = await collectBundleEntries(jobDir, input.command);
  await writeFile(join(jobDir, 'bundle-manifest.json'), `${JSON.stringify({ version: 1, command: input.command, entries, skipped }, null, 2)}\n`);
  const listPath = join(jobDir, 'bundle.list');
  await writeFile(listPath, `${['bundle-manifest.json', ...entries].join('\n')}\n`);
  const out = join(jobDir, 'bundle.tar.gz');
  const tmp = `${out}.tmp`;
  const proc = Bun.spawn(['tar', '-czf', tmp, '-C', jobDir, '-T', listPath], {
    stdout: 'ignore', stderr: 'pipe', stdin: 'ignore', env: { ...process.env, COPYFILE_DISABLE: '1', LC_ALL: 'C' },
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (!isBenignTarExit(code, stderr) || (code !== 0 && !(await exists(tmp)))) throw new Error(`tar failed (${code}): ${stderr.trim().slice(0, 200)}`);
  await rename(tmp, out);
  return { path: out, size: (await stat(out)).size, sha256: await sha256File(out), skipped };
}
