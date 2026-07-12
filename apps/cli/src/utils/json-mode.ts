/**
 * Whether the currently-running command was invoked with --json.
 *
 * `handleApiError` is called from ~160 sites across every command module,
 * none of which pass their local `options.json` through explicitly. Rather
 * than thread it through every call site, index.ts's preAction hook sets
 * this once per invocation from the matched command's own --json flag.
 */
let jsonMode = false;

export function setJsonMode(value: boolean): void {
  jsonMode = value;
}

export function isJsonMode(): boolean {
  return jsonMode;
}
