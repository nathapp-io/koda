import { readFile, stat } from 'node:fs/promises';
import type { SnapshotStory } from '@nathapp/fleet-protocol';
import { clip } from './status-snapshot';

/** S1b §1.2 bounds. The server re-checks each one (`apps/api/src/fleet/sync/event-payloads.ts`). */
export const STORY_LIMITS = Object.freeze({
  count: 100, bytes: 8_192, prdBytes: 1_048_576, title: 80, id: 128, dependsOn: 10, attempts: 1_000_000,
} as const);

const STATUS_RE = /^[a-z][a-z-]{0,31}$/;

export interface StoryList {
  readonly stories: SnapshotStory[];
  readonly truncated: boolean;
}

const storyId = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' && value.length <= STORY_LIMITS.id ? value : null;

/** D147: the defaults are nax's own `loadPRD` normalisation; a story without a usable id is skipped. */
function mapStory(raw: unknown): SnapshotStory | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const story = raw as Record<string, unknown>;
  const id = storyId(story['id']);
  if (id === null) return null;
  const rawStatus = story['status'];
  const status = rawStatus === undefined ? 'pending' : typeof rawStatus === 'string' && STATUS_RE.test(rawStatus) ? rawStatus : 'unknown';
  const rawAttempts = story['attempts'];
  const attempts = typeof rawAttempts === 'number' && Number.isInteger(rawAttempts) && rawAttempts >= 0 ? Math.min(rawAttempts, STORY_LIMITS.attempts) : 0;
  const rawDeps = story['dependencies'];
  const dependsOn = Array.isArray(rawDeps)
    ? rawDeps.map(storyId).filter((dep): dep is string => dep !== null).slice(0, STORY_LIMITS.dependsOn)
    : [];
  const rawTitle = story['title'];
  const title = typeof rawTitle === 'string' ? clip(rawTitle, STORY_LIMITS.title) ?? '' : '';
  return { id, title, status, attempts, dependsOn };
}

/** S1b §1.2: PRD order, cut before the story that would pass 8 KiB serialized, and at most 100 stories. */
export function mapPrdStories(prd: unknown): StoryList | null {
  if (typeof prd !== 'object' || prd === null || Array.isArray(prd)) return null;
  const raw = (prd as Record<string, unknown>)['userStories'];
  if (!Array.isArray(raw)) return null;
  const stories: SnapshotStory[] = [];
  let size = 2;   // "[]"
  for (const item of raw) {
    const story = mapStory(item);
    if (story === null) continue;
    const add = Buffer.byteLength(JSON.stringify(story), 'utf8') + (stories.length > 0 ? 1 : 0);
    if (stories.length === STORY_LIMITS.count || size + add > STORY_LIMITS.bytes) return { stories, truncated: true };
    stories.push(story);
    size += add;
  }
  return { stories, truncated: false };
}

/** Null for a missing, oversize, unreadable or half-written PRD: the snapshot omits the field this poll. */
export async function readPrdStories(path: string): Promise<StoryList | null> {
  try {
    if ((await stat(path)).size > STORY_LIMITS.prdBytes) return null;
    const bytes = await readFile(path);
    if (bytes.length > STORY_LIMITS.prdBytes) return null;   // grew between stat and read
    return mapPrdStories(JSON.parse(bytes.toString('utf8')));
  } catch {
    return null;
  }
}
