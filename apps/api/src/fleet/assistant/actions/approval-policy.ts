import type { ToolOrigin } from '../assistant-tool.types';

/**
 * 3-R5: the four ways a write call can be approved. `none` runs the call at once with no approver, `self` has the
 * actor approve its own action, `agent` has another agent approve it and `human` has a user approve it.
 */
export const APPROVAL_MODES = ['none', 'self', 'agent', 'human'] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/**
 * 3-D13: the approval mode of one write call. This module is the seam every writer reads (US-005's executor calls it
 * once per write call, after the permission check and before the preview), so the answer moves here without touching
 * a call site.
 *
 * 3-R6: these are the code defaults — a user's thread write waits for the thread's user, an agent's thread write and
 * every MCP write run as the calling agent. Nothing answers `self` or `agent` yet: the web policy editor and an agent
 * decide path are koda #301, which replaces this body (and the per-project source behind it), not the call sites.
 *
 * `tool` is part of that seam — a per-tool policy needs it — and is deliberately unread while the defaults are
 * origin- and actor-only. `actor` is the caller principal's type (permissions P1 US-001): an agent's turn has no human
 * to wait for, so its thread write runs at once through the executor's `directWrite` path.
 */
export function approvalModeFor(origin: ToolOrigin, tool: string, actor: 'user' | 'agent'): ApprovalMode {
  void tool;
  return origin.kind === 'thread' && actor === 'user' ? 'human' : 'none';
}
