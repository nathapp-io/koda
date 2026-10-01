/**
 * The command an operator runs on the new machine (docs/deployment/runner.md, "Enroll").
 * `server` is the koda origin the runner will reach; the page passes its own origin (plan D136).
 */
export function enrollCommand(server: string, token: string): string {
  return `koda-runner enroll --server ${server.replace(/\/+$/, '')} --token ${token}`
}
