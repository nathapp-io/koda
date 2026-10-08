import { escapeHtml } from '~/lib/escape-html'
import type { ProjectMember } from '~/composables/useProjectMembers'

/**
 * S4a D504: `@[<label>](user:<cuid>)`, identical to apps/api/src/notifications/mentions.ts. Global: use only through
 * `matchAll` / `replace`.
 */
export const MENTION_TOKEN = /@\[([^[\]@\n]{1,100})\]\(user:(c[a-z0-9]{20,32})\)/g

export type MentionSegment = { readonly text: string } | { readonly userId: string; readonly label: string }

/** The token for one member; `]` and newlines would end the label early, so they are dropped. */
export function mentionToken(label: string, userId: string): string {
  // Same label rules as the API grammar (no [ ] @ or newline, at most 100 chars), so the token always parses.
  const clean = label.replace(/[[\]@\r\n]/g, '').trim().slice(0, 100)
  return `@[${clean || 'user'}](user:${userId})`
}

/** Plain-text rendering (comments): text and mention segments in order. */
export function splitMentions(text: string): readonly MentionSegment[] {
  const { parts, cursor } = [...text.matchAll(MENTION_TOKEN)].reduce<{ parts: readonly MentionSegment[]; cursor: number }>(
    (acc, match) => {
      const start = match.index ?? 0
      const before: readonly MentionSegment[] = start > acc.cursor ? [{ text: text.slice(acc.cursor, start) }] : []
      return { parts: [...acc.parts, ...before, { label: match[1], userId: match[2] }], cursor: start + match[0].length }
    },
    { parts: [], cursor: 0 },
  )
  return cursor < text.length ? [...parts, { text: text.slice(cursor) }] : parts
}

/** `@` at the start of the text or after whitespace, then up to 30 non-space characters, ending at the caret. */
const QUERY = /(^|\s)@([^\s@[\]()]{0,30})$/

export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const match = QUERY.exec(text.slice(0, caret))
  if (!match) return null
  const query = match[2]
  return { start: caret - query.length - 1, query }
}

export function insertMention(text: string, start: number, caret: number, label: string, userId: string): { text: string; caret: number } {
  const token = `${mentionToken(label, userId)} `
  return { text: `${text.slice(0, start)}${token}${text.slice(caret)}`, caret: start + token.length }
}

export function filterMentionCandidates(members: readonly ProjectMember[], query: string, limit = 6): readonly ProjectMember[] {
  const q = query.toLowerCase()
  return members
    .filter((m) => q === '' || (m.name ?? '').toLowerCase().includes(q) || m.email.toLowerCase().includes(q))
    .slice(0, limit)
}

/** Markdown rendering (descriptions): tokens become escaped chips before marked + DOMPurify run. */
export function withMentionChips(markdown: string, nameOf: (userId: string) => string | null): string {
  return markdown.replace(MENTION_TOKEN, (_match, label: string, userId: string) =>
    `<span class="mention-chip">@${escapeHtml(nameOf(userId) ?? label)}</span>`)
}
