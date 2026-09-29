/** Shell convention: 128 + signal number. */
export const EXIT_SIGINT = 130;
export const EXIT_SIGTERM = 143;

export interface SignalTarget {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  exit(code: number): never;
}

/**
 * Exit with 128 + signal on Ctrl+C / SIGTERM, so scripts can tell an
 * interrupted command from a successful one. Messages go to stderr to keep
 * `--json` stdout clean.
 */
export function installSignalHandlers(
  target: SignalTarget = process,
  log: (message: string) => void = (message) => console.error(message),
): void {
  target.on('SIGINT', () => {
    log('\nInterrupted.');
    target.exit(EXIT_SIGINT);
  });
  target.on('SIGTERM', () => {
    log('\nTerminated.');
    target.exit(EXIT_SIGTERM);
  });
}
