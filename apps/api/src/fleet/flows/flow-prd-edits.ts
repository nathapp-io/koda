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

/** Apply description and acceptance-criteria edits independently to a PRD snapshot. */
export function applyPrdEditsToText(prdText: string, edits: FlowPrdEdit[]): PrdEditsResult {
  let document: unknown;
  try {
    document = JSON.parse(prdText);
  } catch {
    return { kind: 'unreadable' };
  }
  if (!isRecord(document) || !Array.isArray(document.userStories)) return { kind: 'unreadable' };

  const refused: FlowPrdEditRefusal[] = [];
  let applied = 0;

  for (const [index, edit] of edits.entries()) {
    const story = document.userStories.find((candidate) => isRecord(candidate) && candidate.id === edit.story);
    if (!story || !isRecord(story)) {
      refused.push({ index, story: edit.story, op: edit.op, reason: 'unknown story' });
      continue;
    }

    const refuse = (reason: string): void => {
      refused.push({ index, story: edit.story, op: edit.op, reason });
    };

    switch (edit.op) {
      case 'replace_description': {
        if (typeof story.description !== 'string') {
          refuse('story malformed');
          break;
        }
        const first = story.description.indexOf(edit.old);
        if (first === -1) {
          refuse('text not found');
          break;
        }
        if (edit.old.length === 0 || story.description.indexOf(edit.old, first + 1) !== -1) {
          refuse('text not unique');
          break;
        }
        if (edit.new === edit.old) {
          refuse('no change');
          break;
        }
        story.description = `${story.description.slice(0, first)}${edit.new}${story.description.slice(first + edit.old.length)}`;
        applied += 1;
        break;
      }
      case 'replace_ac':
      case 'remove_ac': {
        if (!Array.isArray(story.acceptanceCriteria)) {
          refuse('story malformed');
          break;
        }
        const matches = story.acceptanceCriteria
          .map((criterion, criterionIndex) => criterion === edit.old ? criterionIndex : -1)
          .filter((criterionIndex) => criterionIndex !== -1);
        if (matches.length === 0) {
          refuse('text not found');
          break;
        }
        if (matches.length > 1) {
          refuse('text not unique');
          break;
        }
        const criterionIndex = matches[0];
        if (criterionIndex === undefined) {
          refuse('text not found');
          break;
        }
        if (edit.op === 'replace_ac') {
          if (edit.new === edit.old) {
            refuse('no change');
            break;
          }
          if (story.acceptanceCriteria.some((criterion, otherIndex) => otherIndex !== criterionIndex && criterion === edit.new)) {
            refuse('duplicate criterion');
            break;
          }
          story.acceptanceCriteria[criterionIndex] = edit.new;
        } else {
          if (story.acceptanceCriteria.length === 1) {
            refuse('last criterion');
            break;
          }
          story.acceptanceCriteria.splice(criterionIndex, 1);
        }
        applied += 1;
        break;
      }
      case 'add_ac': {
        if (!Array.isArray(story.acceptanceCriteria)) {
          refuse('story malformed');
          break;
        }
        if (story.acceptanceCriteria.includes(edit.new)) {
          refuse('duplicate criterion');
          break;
        }
        story.acceptanceCriteria.push(edit.new);
        applied += 1;
        break;
      }
      case 'add_context_file':
      case 'remove_context_file':
        refuse('unsupported operation');
        break;
    }
  }

  return { kind: 'ok', text: `${JSON.stringify(document, null, 2)}\n`, applied, refused };
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
