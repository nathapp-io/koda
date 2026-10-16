import { isSafeFilterValue } from '../../rag/lance-table-manager';
import type { ForgeTreeEntry } from '../git-broker/forge-tree';
import { matchesKnowledgePattern } from './knowledge-patterns';

/** 1c-c-D9 step 7: largest blob (bytes) a pass reads. */
export const MAX_KNOWLEDGE_FILE_BYTES = 262_144;
/** 1c-c-D9 step 7: most files one repository indexes. */
export const MAX_KNOWLEDGE_FILES = 2_000;
export const KNOWLEDGE_CAP_MESSAGE = '2000-file cap reached';

const NAX_CONTEXT = '.nax/context.md';
const AGENTS = 'AGENTS.md';
const SPEC_PATH = /^\.nax\/features\/[^/]+\/spec\.md$/;

export interface KnowledgeSelection {
  kept: ForgeTreeEntry[];
  skipped: number;
  capMessage: string | null;
}

/** Fixed corpus by path. AGENTS.md is matched here; `selectIndexableEntries` drops it beside `.nax/context.md`. */
export function isIndexablePath(path: string): boolean {
  if (path === 'README.md' || path === NAX_CONTEXT || path === AGENTS) return true;
  if (path.startsWith('docs/') && path.endsWith('.md')) return true;
  return SPEC_PATH.test(path);
}

export function selectIndexableEntries(entries: ForgeTreeEntry[], patterns?: readonly string[]): KnowledgeSelection {
  const hasNaxContext = entries.some((e) => e.type === 'blob' && e.path === NAX_CONTEXT);
  const kept: ForgeTreeEntry[] = [];
  let skipped = 0;
  let capped = false;
  for (const entry of entries) {
    if (entry.type !== 'blob' || !selects(entry.path, patterns)) continue;
    if (entry.path === AGENTS && hasNaxContext) continue;
    if ((entry.size !== null && entry.size > MAX_KNOWLEDGE_FILE_BYTES) || !isSafeFilterValue(entry.path)) {
      skipped += 1;
      continue;
    }
    if (kept.length >= MAX_KNOWLEDGE_FILES) {
      skipped += 1;
      capped = true;
      continue;
    }
    kept.push(entry);
  }
  return { kept, skipped, capMessage: capped ? KNOWLEDGE_CAP_MESSAGE : null };
}

/**
 * US-002: a project that saved patterns selects with them; a project that saved none keeps the fixed 3c-1 rule.
 * An empty list therefore selects nothing — it never falls back to the default corpus.
 */
function selects(path: string, patterns: readonly string[] | undefined): boolean {
  if (patterns === undefined) return isIndexablePath(path);
  return patterns.some((pattern) => matchesKnowledgePattern(path, pattern));
}
