import type { BashAsk } from '../approvals/approval-closer';
import { APPROVAL_TEXT_MAX_BYTES } from '../common/protocol';

const ASK_ID = /^ask-[0-9a-f]{1,16}$/;
const OPTIONS: readonly string[] = ['allow', 'allow-remember', 'deny'];
const MAX_FIELD_CHARS = 2000;

type Obj = Record<string, unknown>;
type Parsed = { ok: true; ask: BashAsk } | { ok: false; reason: string };

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');
const field = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_FIELD_CHARS;
const text = (v: unknown): v is string => typeof v === 'string' && bytes(v) <= APPROVAL_TEXT_MAX_BYTES;

function options(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every((o) => typeof o === 'string' && OPTIONS.includes(o))
    && new Set(v).size === v.length && v.includes('deny');
}

/**
 * Spec §3 / plan D269: validates one relayed ask. A bad payload is a rejected event (warn + activity), never a sync
 * failure; nax then times out and denies. The stored payload is everything except the id and deadline.
 */
export function parseApprovalRequest(payload: unknown): Parsed {
  const p = (payload ?? {}) as Obj;
  const bad = (name: string): Parsed => ({ ok: false, reason: `approval_request.${name}` });
  if (typeof p.naxAskId !== 'string' || !ASK_ID.test(p.naxAskId)) return bad('naxAskId');
  const deadline = typeof p.deadlineAt === 'string' ? new Date(p.deadlineAt) : null;
  if (!deadline || Number.isNaN(deadline.getTime())) return bad('deadlineAt');
  if (!text(p.command)) return bad('command');
  if (typeof p.commandTruncated !== 'boolean') return bad('commandTruncated');
  if (!Number.isInteger(p.maskedCount) || (p.maskedCount as number) < 0) return bad('maskedCount');
  for (const name of ['root', 'stage', 'featureName', 'reason'] as const) if (!field(p[name])) return bad(name);
  if (p.storyId !== null && !field(p.storyId)) return bad('storyId');
  if (!options(p.options)) return bad('options');
  if (p.rawDetail !== undefined && !text(p.rawDetail)) return bad('rawDetail');
  if (p.command === '' && p.rawDetail === undefined) return bad('command');   // nothing a human could read
  return {
    ok: true,
    ask: {
      naxAskId: p.naxAskId, deadlineAt: deadline,
      payload: {
        command: p.command, commandTruncated: p.commandTruncated, maskedCount: p.maskedCount, root: p.root, stage: p.stage,
        storyId: p.storyId, featureName: p.featureName, reason: p.reason, options: [...p.options],
        ...(p.rawDetail !== undefined ? { rawDetail: p.rawDetail } : {}),
      },
    },
  };
}
