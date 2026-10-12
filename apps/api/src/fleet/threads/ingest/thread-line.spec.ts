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
