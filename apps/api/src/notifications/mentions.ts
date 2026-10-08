/** S4a §2.3: at most this many distinct users are mentioned per text; later tokens are plain text. */
export const MENTION_LIMIT = 20;

/**
 * D504: `@[<label>](user:<cuid>)`. The label is display-only: 1-100 chars, never `[`, `]`, `@` or a newline (the bound
 * keeps matching linear on hostile text: each `@[` scans at most 100 chars). The id is a lowercase cuid. Plain `@name`
 * is never parsed. Global: use only through `matchAll` / `replace`, which do not share `lastIndex` state.
 * The web copy in apps/web/lib/mentions.ts must stay identical.
 */
export const MENTION_TOKEN = /@\[([^[\]@\n]{1,100})\]\(user:(c[a-z0-9]{20,32})\)/g;

/** Distinct mentioned user ids in first-seen order, capped at MENTION_LIMIT. */
export function parseMentions(text: string | null | undefined): readonly string[] {
  if (!text) return [];
  const ids = new Set<string>();
  for (const match of text.matchAll(MENTION_TOKEN)) {
    ids.add(match[2]);
    if (ids.size >= MENTION_LIMIT) break; // stop scanning once the cap is reached
  }
  return [...ids];
}

/** Plain-text form for notification excerpts: every token becomes `@label` (no ids, nothing cut mid-token). */
export function mentionsAsText(text: string): string {
  return text.replace(MENTION_TOKEN, (_match, label: string) => `@${label}`);
}
