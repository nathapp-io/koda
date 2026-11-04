import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface FixResult {
  readonly kind: 'pushed' | 'nothing' | 'none';
  readonly logPath: string | null;
}

export interface FixReady {
  readonly markedReady: boolean;
  readonly readyHeld?: string;
  readonly replied?: number;
  readonly resolved?: number;
}

export interface FixState {
  readonly pushedSha: string | null;
  readonly fixReady: FixReady | null;
}

export interface FixOutcome extends FixResult {
  readonly pushedSha: string | null;
  readonly stderrLine: string | null;
  readonly fixReady?: FixReady | null;
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
export async function readFixState(logPath: string): Promise<FixState | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(join(dirname(logPath), 'bot-state.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    const state: unknown = JSON.parse(await handle.readFile('utf8'));
    if (state === null || typeof state !== 'object' || Array.isArray(state)) return null;
    const record = state as Record<string, unknown>;
    const rawSha = record['pushedSha'];
    const pushedSha = typeof rawSha === 'string' && SHA.test(rawSha) ? rawSha : null;
    const markedReady = record['markedReady'];
    if (typeof markedReady !== 'boolean') return { pushedSha, fixReady: null };
    const readyHeld = record['readyHeld'];
    const replied = record['replied'];
    const resolved = record['resolved'];
    return {
      pushedSha,
      fixReady: {
        markedReady,
        ...(typeof readyHeld === 'string' ? { readyHeld: readyHeld.slice(0, 500) } : {}),
        ...(typeof replied === 'number' && Number.isInteger(replied) && replied >= 0 ? { replied } : {}),
        ...(typeof resolved === 'number' && Number.isInteger(resolved) && resolved >= 0 ? { resolved } : {}),
      },
    };
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}
