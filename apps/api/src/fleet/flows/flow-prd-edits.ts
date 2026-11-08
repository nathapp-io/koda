import { sanitizeFlowText } from './flow-calls';

export const FLOW_PRD_EDITS_MAX = 12;
export const FLOW_PRD_EDIT_TEXT_MAX = 400;

export type FlowPrdEdit =
  | { story: string; op: 'replace_description'; old: string; new: string }
  | { story: string; op: 'replace_ac'; old: string; new: string }
  | { story: string; op: 'remove_ac'; old: string }
  | { story: string; op: 'add_ac'; new: string }
  | { story: string; op: 'add_context_file'; path: string }
  | { story: string; op: 'remove_context_file'; path: string };

export type FlowPrdEditRefusal = { index: number; story: string; op: string; reason: string };

export type PrdEditsResult =
  | { kind: 'ok'; text: string; applied: number; refused: FlowPrdEditRefusal[] }
  | { kind: 'unreadable' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeText(value: string): string {
  return sanitizeFlowText(value.split('\u0000').join('\uFFFD'));
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function boundedOld(value: unknown): value is string {
  return nonEmptyText(value) && value.length <= FLOW_PRD_EDIT_TEXT_MAX * 4;
}

/** null when `value` is not an array or any entry is malformed. */
export function parsePrdEdits(value: unknown): FlowPrdEdit[] | null {
  if (!Array.isArray(value)) return null;
  const edits: FlowPrdEdit[] = [];

  for (const entry of value) {
    if (!isRecord(entry) || !nonEmptyText(entry.story) || typeof entry.op !== 'string') return null;
    const story = safeText(entry.story);
    switch (entry.op) {
      case 'replace_description':
        if (!boundedOld(entry.old) || typeof entry.new !== 'string') return null;
        edits.push({ story, op: entry.op, old: safeText(entry.old), new: safeText(entry.new) });
        break;
      case 'replace_ac':
        if (!boundedOld(entry.old) || !nonEmptyText(entry.new)) return null;
        edits.push({ story, op: entry.op, old: safeText(entry.old), new: safeText(entry.new) });
        break;
      case 'remove_ac':
        if (!boundedOld(entry.old)) return null;
        edits.push({ story, op: entry.op, old: safeText(entry.old) });
        break;
      case 'add_ac':
        if (!nonEmptyText(entry.new)) return null;
        edits.push({ story, op: entry.op, new: safeText(entry.new) });
        break;
      case 'add_context_file':
      case 'remove_context_file':
        if (!nonEmptyText(entry.path)) return null;
        edits.push({ story, op: entry.op, path: safeText(entry.path) });
        break;
      default:
        return null;
    }
  }
  return edits;
}
