import { APPROVAL_TEXT_MAX_BYTES, type ApprovalOption, type ApprovalRequestEventPayload } from '@nathapp/fleet-protocol';
import { SYNC_LIMITS, byteLength } from '../sync/batch';
import { parseDetail } from './detail-parser';

/** The `InteractionRequest` nax's webhook plugin POSTs, plus `callbackUrl` (nax interaction/types.ts:17-42). */
export interface NaxAskRequest {
  id: string;
  type: string;
  featureName: string;
  storyId?: string;
  stage: string;
  summary?: string;
  detail?: string;
  options?: Array<{ key: string; label?: string }>;
  timeout?: number;
  createdAt: number;
  metadata?: Record<string, unknown>;
  callbackUrl: string;
}

const ASK_ID = /^ask-[0-9a-f]{1,16}$/;
const OPTION_KEYS: readonly string[] = ['allow', 'allow-remember', 'deny'];
/** Runner-side cap for the short text fields, so the event fits 16 KiB even with a 12 KiB command (server allows 2000). */
const FIELD_MAX_CHARS = 500;
/** `request: ` plus nax's 200-char summary: a line this long may have been cut by nax. */
const SUMMARY_LINE_MAX = 'request: '.length + 200;

export function capUtf8(text: string, maxBytes: number): { text: string; cut: boolean } {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return { text, cut: false };
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;   // never split a multi-byte character
  return { text: bytes.subarray(0, end).toString('utf8'), cut: true };
}

const short = (value: string): string => value.slice(0, FIELD_MAX_CHARS);

/**
 * Spec §4.2 / plan D256, D257, D283: one relayable bash ask, or null (not an approval ask, or not one nax would
 * accept an answer for). The caller answers null with 400, so nax's POST fails and nax denies.
 */
export function buildAskPayload(request: NaxAskRequest): ApprovalRequestEventPayload | null {
  if (request.metadata?.['approvalPrompt'] !== true || request.type !== 'choose' || !ASK_ID.test(request.id)) return null;
  if (typeof request.createdAt !== 'number' || typeof request.timeout !== 'number' || typeof request.detail !== 'string') return null;
  const options = (request.options ?? []).map((o) => o.key).filter((k): k is ApprovalOption => OPTION_KEYS.includes(k));
  if (!options.includes('deny') || new Set(options).size !== options.length) return null;
  const parsed = parseDetail(request.detail);
  const base = {
    naxAskId: request.id,
    deadlineAt: new Date(request.createdAt + request.timeout).toISOString(),
    maskedCount: parsed?.maskedCount ?? 0,
    root: short(parsed?.root ?? ''),
    stage: short(parsed?.stage ?? request.stage),
    storyId: request.storyId === undefined ? null : short(request.storyId),
    featureName: short(request.featureName),
    reason: short(parsed?.reason ?? ''),
    options,
  };
  if (parsed) {
    const command = capUtf8(parsed.command, APPROVAL_TEXT_MAX_BYTES);
    return fit({ ...base, command: command.text, commandTruncated: command.cut });
  }
  const raw = capUtf8(request.detail, APPROVAL_TEXT_MAX_BYTES);
  // Plan D256: a command-less ask (Write/Edit) carries only nax's 200-char summary; a cut one must not be approvable.
  const cutSummary = !request.detail.startsWith('```') && request.detail.split('\n').some((l) => l.startsWith('request: ') && l.length >= SUMMARY_LINE_MAX);
  return fit({ ...base, command: '', rawDetail: raw.text, commandTruncated: raw.cut || cutSummary });
}

/**
 * The server refuses the whole sync when an event's JSON exceeds 16 KiB (`sync-request.parser.ts` parseEvent), so the
 * payload must fit. `byteLength` (batch.ts) measures JSON, which escapes quotes, backslashes and control characters, so
 * the text is shrunk proportionally in raw bytes until the JSON fits. A shrunk text is flagged: deny-only.
 */
function fit(payload: ApprovalRequestEventPayload): ApprovalRequestEventPayload {
  const field: 'command' | 'rawDetail' = payload.rawDetail !== undefined ? 'rawDetail' : 'command';
  let fitted = payload;
  for (let round = 0; round < 8 && byteLength(fitted) > SYNC_LIMITS.payloadBytes; round += 1) {
    const text = fitted[field] ?? '';
    const jsonBytes = byteLength(text);
    const allowed = jsonBytes - (byteLength(fitted) - SYNC_LIMITS.payloadBytes) - 64;
    const target = Math.max(0, Math.floor((Buffer.byteLength(text, 'utf8') * allowed) / jsonBytes));
    fitted = { ...fitted, [field]: capUtf8(text, target).text, commandTruncated: true };
  }
  return fitted;
}
