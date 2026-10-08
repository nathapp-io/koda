/** S4a §2.3: at most this many distinct users are mentioned per text; later tokens are plain text. */
export const MENTION_LIMIT = 20;

/**
 * D504: `@[<label>](user:<cuid>)`. The label is display-only (never `]`); the id is a lowercase cuid. Plain `@name`
 * is never parsed. Global: use only through `matchAll` / `replace`, which do not share `lastIndex` state.
 * The web copy in apps/web/lib/mentions.ts must stay identical.
 */
export const MENTION_TOKEN = /@\[([^\]]+)\]\(user:(c[a-z0-9]{20,32})\)/g;

/** Distinct mentioned user ids in first-seen order, capped at MENTION_LIMIT. */
export function parseMentions(text: string | null | undefined): readonly string[] {
  if (!text) return [];
  return [...text.matchAll(MENTION_TOKEN)].reduce<readonly string[]>((ids, match) => {
    const userId = match[2];
    if (ids.length >= MENTION_LIMIT || ids.includes(userId)) return ids;
    return [...ids, userId];
  }, []);
}
