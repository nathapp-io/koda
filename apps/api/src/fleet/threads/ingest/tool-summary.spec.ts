import {
  cutUtf8, linkApprovalRequest, setApprovalDecision, setToolResult, upsertInformationalQuestion, upsertToolCall,
  type ToolSummaryEntry,
} from './tool-summary';

const call = (callId: string, input: unknown = { pattern: 'foo' }) => ({ callId, name: 'search_repo', input });

describe('tool-summary (US-004)', () => {
  it('US-004 AC1: a tool_call adds an entry whose input is the JSON of the call input', () => {
    expect(upsertToolCall([], call('c1'))).toEqual([
      { callId: 'c1', name: 'search_repo', input: '{"pattern":"foo"}', isError: null, preview: '', decidedBy: null },
    ]);
  });

  it('US-004 AC1: a repeated tool_call for the same callId updates name and input and keeps its result', () => {
    const withResult = setToolResult(upsertToolCall([], call('c1')), 'c1', true, 'refused');
    const again = upsertToolCall(withResult, { callId: 'c1', name: 'read_file', input: { path: 'a' } });
    expect(again).toEqual([
      { callId: 'c1', name: 'read_file', input: '{"path":"a"}', isError: true, preview: 'refused', decidedBy: null },
    ]);
  });

  it('US-004 AC2: a tool_result sets isError and preview on the entry for its callId', () => {
    const entries = setToolResult(upsertToolCall([], call('c1')), 'c1', true, 'refused');
    expect(entries[0]).toMatchObject({ callId: 'c1', isError: true, preview: 'refused' });
  });

  it('US-004 AC2: a tool_result leaves the entries of other callIds unchanged', () => {
    const entries = upsertToolCall(upsertToolCall([], call('c1')), call('c2'));
    const result = setToolResult(entries, 'c1', true, 'refused');
    expect(result[1]).toEqual(entries[1]);
  });

  it('US-004 AC3: a tool_call whose input serializes to 2000 bytes stores a prefix of at most 512 bytes', () => {
    const input = { text: 'a'.repeat(1989) };
    const serialized = JSON.stringify(input);
    expect(Buffer.byteLength(serialized, 'utf8')).toBe(2000);
    const [entry] = upsertToolCall([], { callId: 'c1', name: 'x', input });
    expect(Buffer.byteLength(entry?.input ?? '', 'utf8')).toBeLessThanOrEqual(512);
    expect(entry?.input).toBe(serialized.slice(0, 512));
  });

  it('US-004 AC4: a tool_result with a 2000-byte preview stores a preview of at most 512 bytes', () => {
    const entries = setToolResult(upsertToolCall([], call('c1')), 'c1', false, 'p'.repeat(2000));
    expect(Buffer.byteLength(entries[0]?.preview ?? '', 'utf8')).toBeLessThanOrEqual(512);
    expect(entries[0]?.preview).toBe('p'.repeat(512));
  });

  it('US-004 AC4: the byte cut never splits a multi-byte code point', () => {
    const cut = cutUtf8(`a${'😀'.repeat(200)}`);
    expect(Buffer.byteLength(cut, 'utf8')).toBe(509);
    expect(cut).toBe(`a${'😀'.repeat(127)}`);
  });

  it('US-004 AC4: text within the 512-byte limit is returned unchanged', () => {
    expect(cutUtf8('refused')).toBe('refused');
  });

  it('US-004 AC5: 51 tool_calls with distinct callIds leave 50 entries and no entry for the 51st', () => {
    const ids = Array.from({ length: 51 }, (_, i) => `c${i + 1}`);
    const entries = ids.reduce<ToolSummaryEntry[]>((acc, id) => upsertToolCall(acc, call(id)), []);
    expect(entries).toHaveLength(50);
    expect(entries.some((entry) => entry.callId === 'c51')).toBe(false);
  });

  it('US-004 AC5: a tool_call for an existing callId at the cap still updates that entry', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `c${i + 1}`);
    const full = ids.reduce<ToolSummaryEntry[]>((acc, id) => upsertToolCall(acc, call(id)), []);
    const updated = upsertToolCall(full, { callId: 'c1', name: 'renamed', input: {} });
    expect(updated).toHaveLength(50);
    expect(updated[0]).toMatchObject({ callId: 'c1', name: 'renamed' });
  });

  it('US-004 AC6: approval_requested stores the requestId on the entry for its callId', () => {
    const entries = linkApprovalRequest(upsertToolCall([], call('c1')), 'c1', 'a1');
    expect(entries[0]).toMatchObject({ callId: 'c1', requestId: 'a1' });
  });

  it('US-004 AC6: approval_resolved sets decidedBy on the entry that holds its requestId', () => {
    const linked = linkApprovalRequest(upsertToolCall([], call('c1')), 'c1', 'a1');
    const decided = setApprovalDecision(linked, 'a1', 'profile');
    expect(decided[0]).toMatchObject({ callId: 'c1', decidedBy: 'profile' });
  });

  it('US-004 AC8: an informational question adds an ask_human entry keyed by its requestId', () => {
    expect(upsertInformationalQuestion([], 'q1', 'Which repo?')).toEqual([
      { callId: 'q1', name: 'ask_human', input: '', isError: null, preview: 'Which repo?', decidedBy: null },
    ]);
  });

  it('US-004 AC1: the fold functions return new arrays and never mutate the input', () => {
    const before = upsertToolCall([], call('c1'));
    const snapshot = JSON.parse(JSON.stringify(before)) as ToolSummaryEntry[];
    const after = setToolResult(before, 'c1', true, 'refused');
    expect(after).not.toBe(before);
    expect(before).toEqual(snapshot);
  });
});
