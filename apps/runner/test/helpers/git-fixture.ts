import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Real git in tests, isolated from the developer's global and system config. */
export function isolateGit(): void {
  process.env['GIT_CONFIG_GLOBAL'] = '/dev/null';
  process.env['GIT_CONFIG_NOSYSTEM'] = '1';
  process.env['GIT_TERMINAL_PROMPT'] = '0';
  process.env['GIT_AUTHOR_NAME'] = 'Fixture';
  process.env['GIT_AUTHOR_EMAIL'] = 'fixture@koda.test';
  process.env['GIT_COMMITTER_NAME'] = 'Fixture';
  process.env['GIT_COMMITTER_EMAIL'] = 'fixture@koda.test';
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', env: { ...process.env, LC_ALL: 'C' } });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed (${code}): ${err}`);
  return out.trim();
}

export interface Origin {
  /** Bare repository directory. */
  readonly dir: string;
  /** file:// URL of the bare repository (what a test passes as cloneUrl). */
  readonly url: string;
}

export interface OriginSpec {
  readonly files: Readonly<Record<string, string>>;
  /** Extra branches, each one commit on top of `main` with these files. */
  readonly branches?: ReadonlyArray<{ readonly name: string; readonly files: Readonly<Record<string, string>> }>;
  readonly tags?: readonly string[];
}

async function commitFiles(work: string, files: Readonly<Record<string, string>>, message: string): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(work, path)), { recursive: true });
    await writeFile(join(work, path), content);
  }
  await git(work, 'add', '-A');
  await git(work, 'commit', '-q', '-m', message);
}

/** Commits one file on `branch` of the origin from a throwaway clone and returns the new sha (advances origin from outside the runner's clone). */
export async function pushCommit(base: string, originUrl: string, branch: string, path: string, content: string): Promise<string> {
  const work = await mkdtemp(join(base, 'push-'));
  await git(work, 'clone', '-q', originUrl, '.');
  await git(work, 'checkout', '-q', '-B', branch, `origin/${branch}`).catch(() => git(work, 'checkout', '-q', '-b', branch));
  await mkdir(dirname(join(work, path)), { recursive: true });
  await writeFile(join(work, path), content);
  await git(work, 'add', '-A');
  await git(work, 'commit', '-q', '-m', `push ${path}`);
  await git(work, 'push', '-q', 'origin', branch);
  return git(work, 'rev-parse', 'HEAD');
}

/** A bare origin with `main` (the given files) plus optional branches and tags. */
export async function makeOrigin(base: string, name: string, spec: OriginSpec): Promise<Origin> {
  const dir = join(base, `${name}.git`);
  const work = join(base, `${name}-seed`);
  await mkdir(dir, { recursive: true });
  await git(dir, 'init', '-q', '--bare', '-b', 'main');
  await mkdir(work, { recursive: true });
  await git(work, 'init', '-q', '-b', 'main');
  await git(work, 'remote', 'add', 'origin', dir);
  await commitFiles(work, spec.files, 'seed');
  await git(work, 'push', '-q', 'origin', 'main');
  for (const tag of spec.tags ?? []) {
    await git(work, 'tag', tag);
    await git(work, 'push', '-q', 'origin', tag);
  }
  for (const branch of spec.branches ?? []) {
    await git(work, 'checkout', '-q', '-b', branch.name, 'main');
    await commitFiles(work, branch.files, `on ${branch.name}`);
    await git(work, 'push', '-q', 'origin', branch.name);
    await git(work, 'checkout', '-q', 'main');
  }
  return { dir, url: `file://${dir}` };
}
