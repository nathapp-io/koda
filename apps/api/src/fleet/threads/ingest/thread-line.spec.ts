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
