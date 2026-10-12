import { parseThreadLine } from './thread-line';

describe('parseThreadLine (US-002)', () => {
  it("US-002 AC11: parses a valid input_consumed line", () => {
    expect(parseThreadLine(Buffer.from('{"type":"input_consumed","messageId":"m1"}'))).toEqual({
      type: 'input_consumed',
      messageId: 'm1',
    });
  });

  it('US-002 AC12: rejects an input_consumed line with a non-string messageId', () => {
    expect(parseThreadLine('{"type":"input_consumed","messageId":7}')).toEqual({ bad: true });
  });
});

describe('parseThreadLine (US-003)', () => {
  it('US-003 AC1: parses a turn_start line with its turnId', () => {
    expect(parseThreadLine('{"type":"turn_start","turnId":"t1"}')).toEqual({ type: 'turn_start', turnId: 't1' });
  });

  it('US-003 AC1: rejects a turn_start line with an empty turnId', () => {
    expect(parseThreadLine('{"type":"turn_start","turnId":""}')).toEqual({ bad: true });
  });

  it('US-003 AC1: rejects a turn_start line whose turnId is longer than 128 characters', () => {
    expect(parseThreadLine(`{"type":"turn_start","turnId":"${'t'.repeat(129)}"}`)).toEqual({ bad: true });
  });

  it('US-003 AC2: parses a text_delta line with its round and text', () => {
    expect(parseThreadLine('{"type":"text_delta","turnId":"t1","round":1,"text":"Hel"}')).toEqual({
      type: 'text_delta', turnId: 't1', round: 1, text: 'Hel',
    });
  });

  it('US-003 AC2: rejects a text_delta line whose round is negative', () => {
    expect(parseThreadLine('{"type":"text_delta","turnId":"t1","round":-1,"text":"x"}')).toEqual({ bad: true });
  });

  it('US-003 AC12: replaces an escaped NUL in text_delta text with U+FFFD', () => {
    expect(parseThreadLine('{"type":"text_delta","turnId":"t1","round":1,"text":"a\\u0000b"}')).toEqual({
      type: 'text_delta', turnId: 't1', round: 1, text: 'a\uFFFDb',
    });
  });

  it('US-003 AC2: rejects a text_delta line whose text is not a string', () => {
    expect(parseThreadLine('{"type":"text_delta","turnId":"t1","round":1,"text":3}')).toEqual({ bad: true });
  });

  it('US-003 AC3: parses a stream_reset line with its round', () => {
    expect(parseThreadLine('{"type":"stream_reset","turnId":"t1","round":1}')).toEqual({
      type: 'stream_reset', turnId: 't1', round: 1,
    });
  });

  it('US-003 AC5: parses a completed turn_end line with output, usage and cost', () => {
    expect(parseThreadLine(JSON.stringify({
      type: 'turn_end', turnId: 't1', status: 'completed', output: 'Final',
      usage: { inputTokens: 1, outputTokens: 2 }, costUsd: 0.5,
    }))).toEqual({
      type: 'turn_end', turnId: 't1', status: 'completed', output: 'Final',
      usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0.5,
    });
  });

  it('US-003 AC7: parses an errored turn_end line with its error object', () => {
    expect(parseThreadLine(JSON.stringify({
      type: 'turn_end', turnId: 't1', status: 'errored', output: '',
      usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0, error: { code: 'E', message: 'boom' },
    }))).toMatchObject({ type: 'turn_end', status: 'errored', error: { code: 'E', message: 'boom' } });
  });

  it('US-003 AC5: rejects a turn_end line whose status is not an end status', () => {
    expect(parseThreadLine(JSON.stringify({
      type: 'turn_end', turnId: 't1', status: 'running', output: '', usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0,
    }))).toEqual({ bad: true });
  });

  it('US-003 AC5: rejects a turn_end line with a negative input token count', () => {
    expect(parseThreadLine(JSON.stringify({
      type: 'turn_end', turnId: 't1', status: 'completed', output: '', usage: { inputTokens: -1, outputTokens: 0 }, costUsd: 0,
    }))).toEqual({ bad: true });
  });

  it('US-003 AC5: rejects a turn_end line whose costUsd is negative', () => {
    expect(parseThreadLine(JSON.stringify({
      type: 'turn_end', turnId: 't1', status: 'completed', output: '', usage: { inputTokens: 0, outputTokens: 0 }, costUsd: -1,
    }))).toEqual({ bad: true });
  });

  it('US-003 field rule: rejects a turn_end line with a missing usage object', () => {
    expect(parseThreadLine(JSON.stringify({
      type: 'turn_end', turnId: 't1', status: 'completed', output: '', costUsd: 0,
    }))).toEqual({ bad: true });
  });
});

describe('parseThreadLine (US-005 usage)', () => {
  it('US-005: parses a usage line and defaults absent cache counts to zero', () => {
    expect(parseThreadLine(JSON.stringify({
      type: 'usage', turnId: 't1', round: 1, inputTokens: 100, outputTokens: 20, costUsd: 0.0123,
    }))).toEqual({
      type: 'usage', turnId: 't1', round: 1, inputTokens: 100, outputTokens: 20,
      cacheRead: 0, cacheWrite: 0, costUsd: 0.0123,
    });
  });

  it.each([
    ['negative input token count', { inputTokens: -1, outputTokens: 0, round: 1, costUsd: 0 }],
    ['negative output token count', { inputTokens: 0, outputTokens: -1, round: 1, costUsd: 0 }],
    ['negative cacheRead token count', { inputTokens: 0, outputTokens: 0, cacheRead: -1, round: 1, costUsd: 0 }],
    ['negative cacheWrite token count', { inputTokens: 0, outputTokens: 0, cacheWrite: -1, round: 1, costUsd: 0 }],
    ['non-integer round', { inputTokens: 0, outputTokens: 0, round: 1.5, costUsd: 0 }],
  ])('US-005: rejects a usage line with %s', (_description, fields) => {
    expect(parseThreadLine(JSON.stringify({ type: 'usage', turnId: 't1', ...fields }))).toEqual({ bad: true });
  });

  it.each(['NaN', 'Infinity', '-Infinity', '1e999'])(
    'US-005: rejects a usage line whose costUsd is non-finite (%s)', (costUsd) => {
      const raw = `{"type":"usage","turnId":"t1","round":1,"inputTokens":0,"outputTokens":0,"costUsd":${costUsd}}`;
      expect(parseThreadLine(raw)).toEqual({ bad: true });
    },
  );

  it.each(['invalid', '', 'COMPUTED'])(
    'US-005: rejects a usage line with unsupported costSource %j', (costSource) => {
      expect(parseThreadLine(JSON.stringify({
        type: 'usage', turnId: 't1', round: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, costSource,
      }))).toEqual({ bad: true });
    },
  );

  it('US-005: rejects a usage line whose turnId exceeds the maximum length', () => {
    expect(parseThreadLine(JSON.stringify({
      type: 'usage', turnId: 't'.repeat(129), round: 1, inputTokens: 0, outputTokens: 0, costUsd: 0,
    }))).toEqual({ bad: true });
  });
});

describe('parseThreadLine (US-004)', () => {
  it('US-004 AC1: parses a tool_call line with its callId, name and any JSON input', () => {
    expect(parseThreadLine('{"type":"tool_call","turnId":"t1","callId":"c1","name":"search_repo","input":{"pattern":"foo"}}')).toEqual({
      type: 'tool_call', turnId: 't1', callId: 'c1', name: 'search_repo', input: { pattern: 'foo' },
    });
  });

  it('US-004 AC1: rejects a tool_call line with an empty callId', () => {
    expect(parseThreadLine('{"type":"tool_call","turnId":"t1","callId":"","name":"x","input":{}}')).toEqual({ bad: true });
  });

  it('US-004 AC2: parses a tool_result line with isError and preview', () => {
    expect(parseThreadLine('{"type":"tool_result","turnId":"t1","callId":"c1","isError":true,"preview":"refused"}')).toEqual({
      type: 'tool_result', turnId: 't1', callId: 'c1', isError: true, preview: 'refused',
    });
  });

  it('US-004 AC2: rejects a tool_result line whose isError is not a boolean', () => {
    expect(parseThreadLine('{"type":"tool_result","turnId":"t1","callId":"c1","isError":"yes","preview":""}')).toEqual({ bad: true });
  });

  it('US-004 AC6: parses approval_requested with its requestId and optional callId', () => {
    expect(parseThreadLine('{"type":"approval_requested","requestId":"a1","callId":"c1"}')).toEqual({
      type: 'approval_requested', requestId: 'a1', callId: 'c1',
    });
  });

  it('US-004 AC6: parses approval_resolved with its requestId and decidedBy', () => {
    expect(parseThreadLine('{"type":"approval_resolved","requestId":"a1","decision":"deny","decidedBy":"profile"}')).toEqual({
      type: 'approval_resolved', requestId: 'a1', decidedBy: 'profile',
    });
  });

  it('US-004 AC7: parses an answerable question with its requestId, text and expiresAt', () => {
    expect(parseThreadLine('{"type":"question","turnId":"t1","requestId":"q1","text":"Which repo?","expiresAt":"2026-10-14T01:00:00.000Z"}')).toEqual({
      type: 'question', turnId: 't1', requestId: 'q1', text: 'Which repo?', expiresAt: '2026-10-14T01:00:00.000Z', answerable: true,
    });
  });

  it('US-004 AC8: parses an informational question with answerable false', () => {
    expect(parseThreadLine('{"type":"question","turnId":"t1","requestId":"q1","text":"Which repo?","expiresAt":"2026-10-14T01:00:00.000Z","answerable":false}')).toMatchObject({
      type: 'question', answerable: false,
    });
  });

  it('US-004 AC12: parses session_started with resumed and at', () => {
    expect(parseThreadLine('{"type":"session_started","at":"2026-10-14T00:00:00.000Z","resumed":false,"backend":{"kind":"native"},"skillShas":[]}')).toEqual({
      type: 'session_started', at: '2026-10-14T00:00:00.000Z', resumed: false,
    });
  });

  it('US-004 AC15: parses session_closed with its reason', () => {
    expect(parseThreadLine('{"type":"session_closed","at":"2026-10-14T00:00:00.000Z","reason":"idle"}')).toEqual({
      type: 'session_closed', at: '2026-10-14T00:00:00.000Z', reason: 'idle',
    });
  });

  it('US-004 AC14: parses session_failed with its reason', () => {
    expect(parseThreadLine('{"type":"session_failed","at":"2026-10-14T00:00:00.000Z","reason":"model_unknown"}')).toEqual({
      type: 'session_failed', at: '2026-10-14T00:00:00.000Z', reason: 'model_unknown',
    });
  });

  it('US-004 field rule: drops a session_closed at that is not a date and keeps the line', () => {
    expect(parseThreadLine('{"type":"session_closed","at":"garbage","reason":"idle"}')).toEqual({
      type: 'session_closed', reason: 'idle',
    });
  });

  it('US-004 field rule: rejects a session_failed line with an empty reason', () => {
    expect(parseThreadLine('{"type":"session_failed","reason":""}')).toEqual({ bad: true });
  });
});
