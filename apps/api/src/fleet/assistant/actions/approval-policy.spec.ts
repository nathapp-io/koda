/**
 * Fleet S5b 3 (US-004) — the approval policy seam (3-D13).
 *
 * The policy is a pure function of the call's origin and the caller's type, so these tests pin the four modes and the
 * code defaults (3-R5, 3-R6) without a database: `human` for a user's thread write, `none` for an agent's thread
 * write and for every MCP write.
 *
 * Permissions P1 US-001: the executor passes the caller principal's type, so an agent's thread write no longer waits
 * for a human.
 */
import { KODA_TOOL_DESCRIPTORS } from '../koda-tool-descriptors';
import { APPROVAL_MODES, approvalModeFor, type ApprovalMode } from './approval-policy';
import type { ToolOrigin } from '../assistant-tool.types';

/** The exact origin of AC-2: a REPO thread of project `web`, held by a RUNNING job. */
const THREAD: ToolOrigin = { kind: 'thread', threadId: 't1', jobId: 'j1', threadKind: 'REPO', homeProject: { id: 'p1', slug: 'web' } };
const WORKSPACE: ToolOrigin = { kind: 'thread', threadId: 't2', jobId: 'j2', threadKind: 'WORKSPACE', homeProject: { id: 'p1', slug: 'web' } };
const MCP: ToolOrigin = { kind: 'mcp' };

describe('approvalModeFor (3-D13)', () => {
  it("AC-1: APPROVAL_MODES is ['none', 'self', 'agent', 'human']", () => {
    expect(APPROVAL_MODES).toEqual(['none', 'self', 'agent', 'human']);
    // The exported array is the type's own source, so every entry is an `ApprovalMode`.
    expect(APPROVAL_MODES.every((mode: ApprovalMode) => typeof mode === 'string')).toBe(true);
  });

  it("AC-7: a user's thread origin answers human", () => {
    expect(approvalModeFor(THREAD, 'koda_add_comment', 'user')).toBe('human');
  });

  it('AC-7: an mcp origin answers none', () => {
    expect(approvalModeFor(MCP, 'koda_add_comment', 'agent')).toBe('none');
  });

  it('AC-7: an agent in a thread answers none, so its write runs at once', () => {
    expect(approvalModeFor(THREAD, 'koda_add_comment', 'agent')).toBe('none');
    expect(approvalModeFor(WORKSPACE, 'koda_add_comment', 'agent')).toBe('none');
  });

  it('AC-2: a workspace thread is a thread origin, so a user answers human too', () => {
    expect(approvalModeFor(WORKSPACE, 'koda_add_comment', 'user')).toBe('human');
  });

  it('3-R6: no tool, origin or actor answers self or agent', () => {
    const origins = [THREAD, WORKSPACE, MCP];
    const answers = new Set(origins.flatMap((origin) => KODA_TOOL_DESCRIPTORS.flatMap((tool) =>
      (['user', 'agent'] as const).map((actor) => approvalModeFor(origin, tool.name, actor)))));

    expect([...answers].sort()).toEqual(['human', 'none']);
  });
});
