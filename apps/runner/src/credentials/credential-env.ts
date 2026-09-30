/**
 * D88: the forge-token variables the daemon may have inherited from its operator never reach nax's environment — the
 * job's shims are the only thing that puts a token into a gh/glab child, from the socket. D96: every nax call (probe,
 * job check) uses the same rule.
 */
const CREDENTIAL_ENV_VARS: readonly string[] = ['GH_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_TOKEN', 'GITLAB_TOKEN', 'GL_TOKEN'];

export function withoutCredentialVars(env: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string | undefined>> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !CREDENTIAL_ENV_VARS.includes(name)));
}
