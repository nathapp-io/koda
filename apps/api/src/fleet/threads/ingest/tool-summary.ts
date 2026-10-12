/**
 * Pure updates to a message's `toolSummary` (fleet S5a §3.3). Each function returns a new array and never mutates its
 * input. `requestId` is kept on the entry only so an approval can be matched to its tool call.
 */

import type { ToolThreadLine } from './thread-line';

export interface ToolSummaryEntry {
  callId: string;
  name: string;
  input: string;
  isError: boolean | null;
  preview: string;
  decidedBy: string | null;
  requestId?: string;
}

export const TOOL_SUMMARY_MAX_ENTRIES = 50;
export const TOOL_SUMMARY_TEXT_MAX_BYTES = 512;

/** Cuts `text` to at most `maxBytes` UTF-8 bytes, never splitting a code point. */
export function cutUtf8(text: string, maxBytes: number = TOOL_SUMMARY_TEXT_MAX_BYTES): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let bytes = 0;
  let out = '';
  for (const codePoint of text) {
    const size = Buffer.byteLength(codePoint, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    out += codePoint;
  }
  return out;
}

/** Adds the entry for a tool call, or refreshes name and input of the existing one. A 51st callId is skipped. */
export function upsertToolCall(entries: readonly ToolSummaryEntry[], call: { callId: string; name: string; input: unknown }): ToolSummaryEntry[] {
  const input = cutUtf8(JSON.stringify(call.input));
  if (entries.some((entry) => entry.callId === call.callId)) {
    return entries.map((entry) => (entry.callId === call.callId ? { ...entry, name: call.name, input } : entry));
  }
  if (entries.length >= TOOL_SUMMARY_MAX_ENTRIES) return [...entries];
  return [...entries, { callId: call.callId, name: call.name, input, isError: null, preview: '', decidedBy: null }];
}

export function setToolResult(entries: readonly ToolSummaryEntry[], callId: string, isError: boolean, preview: string): ToolSummaryEntry[] {
  return entries.map((entry) => (entry.callId === callId ? { ...entry, isError, preview: cutUtf8(preview) } : entry));
}

export function linkApprovalRequest(entries: readonly ToolSummaryEntry[], callId: string, requestId: string): ToolSummaryEntry[] {
  return entries.map((entry) => (entry.callId === callId ? { ...entry, requestId } : entry));
}

export function setApprovalDecision(entries: readonly ToolSummaryEntry[], requestId: string, decidedBy: string): ToolSummaryEntry[] {
  return entries.map((entry) => (entry.requestId === requestId ? { ...entry, decidedBy } : entry));
}

/** Applies one tool or approval stream event to a message's summary. */
export function upsertToolSummary(entries: readonly ToolSummaryEntry[], line: ToolThreadLine): ToolSummaryEntry[] {
  switch (line.type) {
    case 'tool_call':
      return upsertToolCall(entries, line);
    case 'tool_result':
      return setToolResult(entries, line.callId, line.isError, line.preview);
    case 'approval_requested':
      return line.callId === undefined ? [...entries] : linkApprovalRequest(entries, line.callId, line.requestId);
    case 'approval_resolved':
      return setApprovalDecision(entries, line.requestId, line.decidedBy);
  }
}

/** An informational question is recorded as an `ask_human` entry, since `turn_end` replaces the message content. */
export function upsertInformationalQuestion(entries: readonly ToolSummaryEntry[], requestId: string, text: string): ToolSummaryEntry[] {
  if (entries.some((entry) => entry.callId === requestId) || entries.length >= TOOL_SUMMARY_MAX_ENTRIES) return [...entries];
  return [...entries, { callId: requestId, name: 'ask_human', input: '', isError: null, preview: cutUtf8(text), decidedBy: null }];
}
