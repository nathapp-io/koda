import type { ReviewDecision } from '@nathapp/fleet-protocol';
import type { MemoryItem } from './memory-item-repository';

export const REVIEW_EVENT_SOURCE = 'review_event';
export const MAX_REVIEW_DECISIONS = 100;
export const MAX_DECISION_STATEMENT = 2000;
export const MAX_DECISIONS_FILE_BYTES = 262144;

export function reviewRepoSubject(repoId: string): string {
  return `repo:${repoId}`;
}

function formatStatement(item: MemoryItem): string {
  const statement = item.object == null || item.object === ''
    ? item.predicate
    : `${item.predicate}: ${item.object}`;
  if (statement.length <= MAX_DECISION_STATEMENT) return statement;

  let cutLength = MAX_DECISION_STATEMENT - 3;
  if (statement.charCodeAt(cutLength - 1) >= 0xd800 && statement.charCodeAt(cutLength - 1) <= 0xdbff) {
    cutLength -= 1;
  }
  return `${statement.slice(0, cutLength)}...`;
}

export function buildReviewDecisions(recorded: MemoryItem[], reviewMinted: MemoryItem[]): ReviewDecision[] {
  const decisions = [...recorded, ...reviewMinted]
    .slice(0, MAX_REVIEW_DECISIONS)
    .map((item) => ({
      id: item.id,
      statement: formatStatement(item),
      source: `koda:memory/${item.id}`,
    }));

  while (decisions.length > 0 && Buffer.byteLength(JSON.stringify({ version: 1, decisions })) > MAX_DECISIONS_FILE_BYTES) {
    decisions.pop();
  }
  return decisions;
}
