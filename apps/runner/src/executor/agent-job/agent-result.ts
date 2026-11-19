import { open } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { join } from 'node:path';
import { AGENT_RESULT_LIMITS, type AgentJobResult } from '@nathapp/fleet-protocol';
import { clip, formatCost } from '../../watcher/status-snapshot';
import { tailBytes } from '../config-job/result-fit';
import { sanitizeDiagnostic } from '../../diagnostics';

export const AGENT_STDOUT_MAX_BYTES = 16 * 1024 * 1024;

export type RawAgentResult = {
  agent: string;
  model?: string;
  status: AgentJobResult['status'];
  output: string;
  deniedAsks: Array<
    | { kind: 'approval'; tool: string; summary: string }
    | { kind: 'question'; text: string }
  >;
  costUsd?: number;
};

export type ReadAgentResult = { ok: true; result: RawAgentResult } | { ok: false; stderrLine?: string };

const statuses: readonly string[] = ['completed', 'failed', 'cancelled', 'timeout'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseResult(value: unknown): RawAgentResult | undefined {
  if (!isRecord(value) || typeof value.agent !== 'string' || typeof value.output !== 'string' ||
      typeof value.status !== 'string' || !statuses.includes(value.status)) return undefined;
  if (value.model !== undefined && typeof value.model !== 'string') return undefined;
  if (value.costUsd !== undefined && typeof value.costUsd !== 'number') return undefined;
  if (!Array.isArray(value.deniedAsks)) return undefined;
  const deniedAsks: RawAgentResult['deniedAsks'] = [];
  for (const ask of value.deniedAsks) {
    if (!isRecord(ask)) return undefined;
    if (ask.kind === 'question' && typeof ask.text === 'string') deniedAsks.push({ kind: 'question', text: ask.text });
    else if (ask.kind === 'approval' && typeof ask.tool === 'string' && typeof ask.summary === 'string') {
      deniedAsks.push({ kind: 'approval', tool: ask.tool, summary: ask.summary });
    } else return undefined;
  }
  return {
    agent: value.agent,
    ...(typeof value.model === 'string' ? { model: value.model } : {}),
    status: value.status as RawAgentResult['status'],
    output: value.output,
    deniedAsks,
    ...(typeof value.costUsd === 'number' ? { costUsd: value.costUsd } : {}),
  };
}

/** First non-empty nax.stderr line: UTF-16 units excluding the LF or CRLF terminator, then sanitized. */
const STDERR_LINE_MAX_CHARS = 4_000;
/** review-1118 US-003: and the sanitized reason is clipped to this. */
const STDERR_LINE_MAX_OUTPUT = 300;

/**
 * The first non-empty line of nax.stderr, sanitized, or `undefined`. Review-1118 US-003 post-review: a line longer
 * than the read bound is dropped whole rather than clipped — the sanitizer cannot see the closing delimiter of a URL
 * credential that starts inside the collected prefix and ends past it, so a cut prefix could carry a secret.
 */
async function stderrLine(jobDir: string): Promise<string | undefined> {
  let file;
  try {
    file = await open(join(jobDir, 'nax.stderr'), 'r');
    const decoder = new StringDecoder('utf8');
    const buffer = Buffer.alloc(4096);
    let line = '';
    let nonEmpty = false;
    const sanitized = (value: string): string | undefined => {
      const clean = sanitizeDiagnostic(value.endsWith('\r') ? value.slice(0, -1) : value);
      return clean.length === 0 ? undefined : clip(clean, STDERR_LINE_MAX_OUTPUT);
    };
    /** `done` answers the read: the first non-empty line is found, or it is too long to keep. */
    const inspect = (text: string): { done: boolean; line?: string } => {
      for (const character of text) {
        if (character === '\n') {
          if (nonEmpty) return { done: true, line: sanitized(line) };
          line = '';
          nonEmpty = false;
          continue;
        }
        const blank = character.trim().length === 0;
        if (!blank) nonEmpty = true;
        const nextLength = line.length + character.length;
        // Keep one provisional CR beyond the bound only until we know whether it terminates a CRLF line.
        const possibleTerminator = character === '\r' && nextLength === STDERR_LINE_MAX_CHARS + 1;
        if (nextLength > STDERR_LINE_MAX_CHARS && !possibleTerminator) {
          if (nonEmpty) return { done: true };   // no detail rather than an unsanitizable prefix
          continue;                              // a blank line over the bound only delays the next one
        }
        line += character;
      }
      return { done: false };
    };
    let eof = false;
    while (!eof) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) eof = true;
      else {
        const found = inspect(decoder.write(buffer.subarray(0, bytesRead)));
        if (found.done) return found.line;
      }
    }
    const final = inspect(decoder.end());
    if (final.done) return final.line;
    return nonEmpty && line.length <= STDERR_LINE_MAX_CHARS ? sanitized(line) : undefined;
  } catch {
    return undefined;
  } finally {
    await file?.close();
  }
}

export async function readAgentResult(jobDir: string): Promise<ReadAgentResult> {
  try {
    const file = await open(join(jobDir, 'nax.stdout'), 'r');
    let text: string;
    try {
      const buffer = Buffer.alloc(AGENT_STDOUT_MAX_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.byteLength) {
        const read = await file.read(buffer, bytesRead, buffer.byteLength - bytesRead, bytesRead);
        if (read.bytesRead === 0) break;
        bytesRead += read.bytesRead;
      }
      if (bytesRead > AGENT_STDOUT_MAX_BYTES) {
        const line = await stderrLine(jobDir);
        return { ok: false, ...(line !== undefined ? { stderrLine: line } : {}) };
      }
      text = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await file.close();
    }
    const parsed = parseResult(JSON.parse(text) as unknown);
    if (parsed) return { ok: true, result: parsed };
  } catch {
    // Missing, unreadable, empty, or malformed stdout is a failed read; stderr is diagnostic only.
  }
  const line = await stderrLine(jobDir);
  return { ok: false, ...(line !== undefined ? { stderrLine: line } : {}) };
}

function clipText(value: string, max: number): string {
  return clip(value, max) ?? value;
}

/**
 * The API's own string sanitization, applied here first so the fitted result is measured as the server
 * will store it: `stripNul` in apps/api/src/fleet/sync/sync-request.parser.ts replaces every U+0000 with
 * U+FFFD (Postgres refuses U+0000). A NUL is one UTF-8 byte here and three there, so a result fitted
 * before that replacement can outgrow `maxOutputBytes` or `budgetBytes` on the server, which then drops
 * the whole `agentResult` and keeps only the rest of the snapshot.
 */
const NUL_REPLACEMENT = '\uFFFD';

export function apiSafeText(value: string): string {
  return value.includes('\u0000') ? value.replaceAll('\u0000', NUL_REPLACEMENT) : value;
}

/** The result as the server will hold it, so every bound below is measured after the replacement. */
function serverText(result: RawAgentResult): RawAgentResult {
  return {
    ...result,
    output: apiSafeText(result.output),
    ...(result.model !== undefined ? { model: apiSafeText(result.model) } : {}),
    deniedAsks: result.deniedAsks.map((ask) => (ask.kind === 'question'
      ? { kind: 'question' as const, text: apiSafeText(ask.text) }
      : { kind: 'approval' as const, tool: apiSafeText(ask.tool), summary: apiSafeText(ask.summary) })),
  };
}

function fitAsk(ask: RawAgentResult['deniedAsks'][number]): { ask: RawAgentResult['deniedAsks'][number]; clipped: boolean } {
  if (ask.kind === 'question') {
    const text = clipText(ask.text, AGENT_RESULT_LIMITS.maxAskChars);
    return { ask: { kind: 'question', text }, clipped: text !== ask.text };
  }
  const tool = clipText(ask.tool, AGENT_RESULT_LIMITS.maxToolChars);
  const summary = clipText(ask.summary, AGENT_RESULT_LIMITS.maxAskChars);
  return { ask: { kind: 'approval', tool, summary }, clipped: tool !== ask.tool || summary !== ask.summary };
}

/** Fit within protocol snapshot limits, preferring the earliest asks and the tail of output. */
export function fitAgentResult(raw: RawAgentResult): AgentJobResult {
  // Replace U+0000 first: the API does it before it validates, and fitting the pre-replacement bytes
  // would let a result that fits here fail its bound there.
  const result = serverText(raw);
  const cappedAsks = result.deniedAsks.slice(0, AGENT_RESULT_LIMITS.maxDeniedAsks).map(fitAsk);
  let asks = cappedAsks.map(({ ask }) => ask);
  let output = tailBytes(result.output, AGENT_RESULT_LIMITS.maxOutputBytes);
  let truncated = output !== result.output;
  let deniedAsksTruncated = result.deniedAsks.length > cappedAsks.length || cappedAsks.some(({ clipped }) => clipped);
  const model = result.model === undefined ? undefined : clipText(result.model, AGENT_RESULT_LIMITS.maxModelChars);
  const build = (): AgentJobResult => ({
    status: result.status,
    ...(model !== undefined ? { model } : {}),
    output,
    truncated,
    deniedAsks: asks,
    deniedAsksTruncated,
    ...(result.costUsd !== undefined && formatCost(result.costUsd) !== undefined ? { costUsd: formatCost(result.costUsd) } : {}),
  });
  let fitted = build();
  while (Buffer.byteLength(JSON.stringify(fitted), 'utf8') > AGENT_RESULT_LIMITS.budgetBytes) {
    if (asks.length > 0) {
      asks = asks.slice(0, -1);
      deniedAsksTruncated = true;
    } else if (Buffer.byteLength(output, 'utf8') > 0) {
      output = tailBytes(output, Math.floor(Buffer.byteLength(output, 'utf8') / 2));
      truncated = true;
    } else break;
    fitted = build();
  }
  return fitted;
}
