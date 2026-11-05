/**
 * D88: the forge-token variables the daemon may have inherited from its operator never reach nax's environment — the
 * job's shims are the only thing that puts a token into a gh/glab child, from the socket. D96: every nax call (probe,
 * job check) uses the same rule. US-009: the provider-key socket path is per job too, so an inherited one must never
 * point a job at another job's socket; the job's own path is set after the strip.
 */
const CREDENTIAL_ENV_VARS: readonly string[] = ['GH_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_TOKEN', 'GITLAB_TOKEN', 'GL_TOKEN', 'NAX_FORGE_TOKEN', 'NAX_FORGE_TOKEN_FILE', 'NAX_FORGE_LOGIN', 'NAX_FORGE_USER_ID', 'KODA_PROVIDER_CRED_SOCKET'];

export function withoutCredentialVars(env: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string | undefined>> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !CREDENTIAL_ENV_VARS.includes(name)));
}
