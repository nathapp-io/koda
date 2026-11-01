import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface FixResult {
  readonly kind: 'pushed' | 'nothing' | 'none';
  readonly logPath: string | null;
}

export interface FixOutcome extends FixResult {
  readonly pushedSha: string | null;
  readonly stderrLine: string | null;
}

const LOG_MARKER = 'nax bot fix: log ';
const SHA = /^[0-9a-f]{40}$/;

/** Reads only line-start markers and accepts a result for the assigned PR. */
export async function readFixResult(stdoutPath: string, prNumber: number): Promise<FixResult> {
  let stdout: string;
  try {
    stdout = await readFile(stdoutPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'none', logPath: null };
    throw error;
  }

  let kind: FixResult['kind'] = 'none';
  let logPath: string | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (logPath === null && line.startsWith(LOG_MARKER)) {
      const path = line.slice(LOG_MARKER.length).trim();
      if (path !== '') logPath = path;
    }
    const prefix = `nax bot fix: PR #${prNumber} — `;
    if (!line.startsWith(prefix)) continue;
    const result = line.slice(prefix.length);
    if (result.startsWith('pushed ')) kind = 'pushed';
    else if (result.startsWith('nothing to fix')) kind = 'nothing';
  }
  return { kind, logPath };
}

/** The run state sits beside the bot.jsonl named by nax's log marker. */
export async function readPushedSha(logPath: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(join(dirname(logPath), 'bot-state.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    const state: unknown = JSON.parse(await handle.readFile('utf8'));
    if (state === null || typeof state !== 'object' || Array.isArray(state)) return null;
    const pushedSha = (state as Record<string, unknown>)['pushedSha'];
    return typeof pushedSha === 'string' && SHA.test(pushedSha) ? pushedSha : null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP' || error instanceof SyntaxError) return null;
    throw error;
  } finally {
    await handle?.close();
  }
}
