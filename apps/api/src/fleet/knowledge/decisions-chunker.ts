/**
 * Fleet S5b knowledge outcomes (3c-2-D5): the deterministic `decisions.jsonl` chunker.
 *
 * Pure text in, chunks out — no Nest provider, no model, no clock. Every workflow RUN ends with a
 * decisions log whose lines are advisor rulings; each line that parses as a JSON object with a
 * string `id` becomes one chunk. The anchor rule is the repository chunker's own (1c-c-D8 rule 8),
 * reused through its exported `slug`/`uniqueAnchor` helpers so both corpora answer one anchor shape.
 */
import { slug, uniqueAnchor, type MarkdownChunk } from './markdown-chunker';

/** Later lines are ignored, which keeps one decisions file under the chunk store's 2000-row read cap. */
export const MAX_DECISION_CHUNKS = 1000;
/** 1c-c-D8 rule 7: the abstract stays extractive and capped, never an LLM-written summary. */
const MAX_ABSTRACT_CHARS = 300;

/**
 * One chunk per decision line, in file order, at most {@link MAX_DECISION_CHUNKS} of them: chunk 0 is
 * the first decision, never a document summary.
 */
export function chunkDecisions(text: string): MarkdownChunk[] {
  const counts = new Map<string, number>();
  const used = new Set<string>();
  const chunks: MarkdownChunk[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const decision = parseDecision(line);
    if (decision === null) continue;
    chunks.push({
      chunkIndex: chunks.length,
      title: `Decision ${decision.id}`,
      headingPath: `Decision ${decision.id}`,
      anchor: uniqueAnchor(slug(decision.id), counts, used),
      abstract: decision.rationale === null ? '' : decision.rationale.slice(0, MAX_ABSTRACT_CHARS),
      text: decisionText(decision),
    });
    if (chunks.length === MAX_DECISION_CHUNKS) break;
  }
  return chunks;
}

interface Decision {
  id: string;
  kind: string | null;
  questionId: string | null;
  chosenOptionId: string | null;
  actionType: string | null;
  rationale: string | null;
  decidedAt: string | null;
  model: string | null;
  confidence: string | null;
}

/** A line is a decision only when it is a JSON object with a string `id`; anything else is skipped. */
function parseDecision(line: string): Decision | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isJsonObject(value) || typeof value.id !== 'string') return null;
  const action = value.action;
  return {
    id: value.id,
    kind: readString(value.kind),
    questionId: readString(value.questionId),
    chosenOptionId: readString(value.chosenOptionId),
    actionType: isJsonObject(action) ? readString(action.type) : null,
    rationale: readString(value.rationale),
    decidedAt: readString(value.decidedAt),
    model: readString(value.model),
    confidence: readString(value.confidence),
  };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every optional field is read only when it is a string; a boolean or a number counts as absent. */
function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Each line is omitted when its values are absent; only a missing `kind` trims the first line. */
function decisionText(decision: Decision): string {
  const lines = [decision.kind === null ? `Decision ${decision.id}` : `Decision ${decision.id} (${decision.kind})`];
  if (decision.questionId !== null) lines.push(`Question: ${decision.questionId}`);
  if (decision.chosenOptionId !== null && decision.actionType !== null) {
    lines.push(`Chosen: ${decision.chosenOptionId} -> ${decision.actionType}`);
  }
  if (decision.rationale !== null) lines.push(`Rationale: ${decision.rationale}`);
  if (decision.decidedAt !== null) lines.push(`Decided: ${decision.decidedAt}${decidedParts(decision)}`);
  return lines.join('\n');
}

function decidedParts(decision: Decision): string {
  const model = decision.model === null ? '' : ` by ${decision.model}`;
  const confidence = decision.confidence === null ? '' : `, confidence ${decision.confidence}`;
  return `${model}${confidence}`;
}
