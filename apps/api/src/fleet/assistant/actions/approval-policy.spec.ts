/**
 * Fleet S5b 3 (US-004) — the approval policy seam (3-D13).
 *
 * The policy is a pure function of the call's origin, so these tests pin the four modes and the two code defaults
 * (3-R5, 3-R6) without a database: `human` for a thread write, `none` for an MCP write, and nothing else.
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

  it('AC-2: a thread origin answers human', () => {
    expect(approvalModeFor(THREAD, 'koda_add_comment')).toBe('human');
  });

  it('AC-3: an mcp origin answers none', () => {
    expect(approvalModeFor(MCP, 'koda_add_comment')).toBe('none');
  });

  it('AC-2: every thread kind is a thread origin, so a workspace thread answers human too', () => {
    expect(approvalModeFor(WORKSPACE, 'koda_add_comment')).toBe('human');
  });

  it('3-R6: no tool and no origin answers self or agent', () => {
    const origins = [THREAD, WORKSPACE, MCP];
    const answers = new Set(origins.flatMap((origin) => KODA_TOOL_DESCRIPTORS.map((tool) => approvalModeFor(origin, tool.name))));

    expect([...answers].sort()).toEqual(['human', 'none']);
  });
});
