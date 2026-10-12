export interface InputConsumedThreadLine {
  type: 'input_consumed';
  messageId: string;
}

export type ThreadLine = InputConsumedThreadLine;
export type ParsedThreadLine = ThreadLine | { bad: true } | { ignored: true };

export function parseThreadLine(_raw: Buffer | string): ParsedThreadLine {
  return { bad: true };
}
