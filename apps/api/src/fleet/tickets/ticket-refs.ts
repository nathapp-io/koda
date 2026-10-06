import { ValidationAppException } from '@nathapp/nestjs-common';
import { parseTicketRef } from '../../common/utils/ticket-ref.util';

/** Spec §2.1 (D450). */
export const MAX_DISPATCH_TICKETS = 20;

export interface ParsedDispatchRef {
  ref: string;
  number: number;
}

function fail(reason: string): never {
  throw new ValidationAppException({ reason }, 'fleet.dispatchInput');
}

/** Upper-cased, deduplicated `KEY-N` refs of this project, in first-seen order. Throws 400 naming the first bad ref. */
export function parseDispatchRefs(refs: readonly string[], projectKey: string): ParsedDispatchRef[] {
  const normalized = [...new Set(refs.map((r) => r.trim().toUpperCase()))];
  if (normalized.length > MAX_DISPATCH_TICKETS) fail(`too many tickets (max ${MAX_DISPATCH_TICKETS})`);
  return normalized.map((ref) => {
    const parsed = parseTicketRef(ref);
    if (!parsed || parsed.prefix !== projectKey || parsed.number < 1) fail(`ticket ${ref}`);
    return { ref, number: parsed.number };
  });
}
