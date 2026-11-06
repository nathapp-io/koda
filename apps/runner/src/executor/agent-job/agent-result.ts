import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AGENT_RESULT_LIMITS, type AgentJobResult } from '@nathapp/fleet-protocol';
import { formatCost } from '../../watcher/status-snapshot';
import { tailBytes } from '../config-job/result-fit';

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

async function stderrLine(jobDir: string): Promise<string | undefined> {
  try {
    const text = await readFile(join(jobDir, 'nax.stderr'), 'utf8');
    const line = text.split(/\r?\n/).find((candidate) => candidate.trim().length > 0);
    return line === undefined ? undefined : line.slice(0, 300);
  } catch {
    return undefined;
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

function fitAsk(ask: RawAgentResult['deniedAsks'][number]): { ask: RawAgentResult['deniedAsks'][number]; clipped: boolean } {
  if (ask.kind === 'question') {
    const text = ask.text.slice(0, AGENT_RESULT_LIMITS.maxAskChars);
    return { ask: { kind: 'question', text }, clipped: text !== ask.text };
  }
  const tool = ask.tool.slice(0, AGENT_RESULT_LIMITS.maxToolChars);
  const summary = ask.summary.slice(0, AGENT_RESULT_LIMITS.maxAskChars);
  return { ask: { kind: 'approval', tool, summary }, clipped: tool !== ask.tool || summary !== ask.summary };
}

/** Fit within protocol snapshot limits, preferring the earliest asks and the tail of output. */
export function fitAgentResult(result: RawAgentResult): AgentJobResult {
  const cappedAsks = result.deniedAsks.slice(0, AGENT_RESULT_LIMITS.maxDeniedAsks).map(fitAsk);
  let asks = cappedAsks.map(({ ask }) => ask);
  let output = tailBytes(result.output, AGENT_RESULT_LIMITS.maxOutputBytes);
  let truncated = output !== result.output;
  let deniedAsksTruncated = result.deniedAsks.length > cappedAsks.length || cappedAsks.some(({ clipped }) => clipped);
  const model = result.model?.slice(0, AGENT_RESULT_LIMITS.maxModelChars);
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
