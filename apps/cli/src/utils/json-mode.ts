/**
 * Whether the currently-running command was invoked with --json.
 *
 * `handleApiError` is called from ~160 sites across every command module,
 * none of which pass their local `options.json` through explicitly. Rather
 * than thread it through every call site, index.ts's preAction hook sets
 * this once per invocation from the matched command's own --json flag.
 *
 * This is process-global state, safe only under the CLI's one-command-per-
 * process model (a fresh flag is set at the start of every invocation). Do
 * not reuse this module if index.ts is ever imported into a long-running
 * host (a REPL, a server) that could run multiple commands per process.
 */
let jsonMode = false;

export function setJsonMode(value: boolean): void {
  jsonMode = value;
}

export function isJsonMode(): boolean {
  return jsonMode;
}
