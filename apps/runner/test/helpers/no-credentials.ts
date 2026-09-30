import type { CredentialProvider } from '../../src/credentials/broker';

/** For HostExecutor specs against `file://` origins, which never need credentials (D83). */
export const NO_CREDENTIALS: CredentialProvider = {
  acquire: async () => ({ ok: true, credentials: { helper: null, binDir: null } }),
  release: async () => undefined,
};
