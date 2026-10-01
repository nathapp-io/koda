export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function firstLine(text: string, max = 200): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return line.slice(0, max);
}

/** D97: a check that stops the daemon, or enroll, before it runs; the message is written for the operator. */
export class StartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartupError';
  }
}
