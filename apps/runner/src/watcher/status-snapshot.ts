import { readFile } from 'node:fs/promises';
import type { SnapshotEventPayload } from '@nathapp/fleet-protocol';
import { parseStatusView, type StatusView } from '../verdict/status-view';

export interface SnapshotExtras {
  readonly logRunId?: string | null;
  readonly costRunId?: string | null;
  readonly resultBranch?: string;
  readonly resultSha?: string;
  readonly droppedLogs?: number;
}

/** Decimal string with at most 4 fraction digits, the server's COST_RE (`event-payloads.ts`). */
export function formatCost(spent: unknown): string | undefined {
  if (typeof spent !== 'number' || !Number.isFinite(spent) || spent < 0 || spent >= 1e8) return undefined;
  return spent.toFixed(4);
}

/** The server's `escalationReason` limit (`event-payloads.ts`: `str(p.escalationReason, 2_000)`); a longer one would 400 the whole event. */
const ESCALATION_REASON_MAX = 2_000;

function clip(text: string | undefined, max: number): string | undefined {
  if (text === undefined || text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max); // never leave half a surrogate pair
}

export function mapStatusToSnapshot(status: StatusView, extras: SnapshotExtras = {}): SnapshotEventPayload {
  const finish = status.postRun?.finish;
  const heartbeat = status.lastHeartbeat !== undefined && !Number.isNaN(Date.parse(status.lastHeartbeat)) ? status.lastHeartbeat : undefined;
  const cost = formatCost(status.cost?.spent);
  const entries: Array<[string, unknown]> = [
    ['naxRunId', status.run.id],
    ['naxLogRunId', extras.logRunId ?? undefined],
    ['naxCostRunId', extras.costRunId ?? undefined],
    ['progress', status.progress],
    ['currentStoryId', status.current?.storyId ?? null],
    ['currentPhase', status.current?.phase ?? null],
    ['costSpentUsd', cost],
    ['heartbeatAt', heartbeat],
    ['finishResult', finish?.result],
    ['resultPrUrl', finish?.url],
    ['escalationReason', clip(finish?.escalationReason, ESCALATION_REASON_MAX)],
    ['resultBranch', extras.resultBranch],
    ['resultSha', extras.resultSha],
    ['droppedLogs', extras.droppedLogs && extras.droppedLogs > 0 ? extras.droppedLogs : undefined],
  ];
  return Object.fromEntries(entries.filter(([, v]) => v !== undefined)) as SnapshotEventPayload;
}

export async function readStatusFile(path: string): Promise<{ status: StatusView | null; problem: 'missing' | 'invalid' | null }> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    return { status: null, problem: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid' };
  }
  try {
    const status = parseStatusView(JSON.parse(text));
    return status ? { status, problem: null } : { status: null, problem: 'invalid' };
  } catch {
    return { status: null, problem: 'invalid' };
  }
}
