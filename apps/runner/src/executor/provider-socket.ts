// apps/runner/src/executor/provider-socket.ts
import type { CredentialProvider } from '../credentials/broker';
import { PROVIDER_CRED_SOCKET_ENV } from '../credentials/provider-cred';
import { errorMessage } from '../errors';
import type { JobRow } from '../journal/types';
import type { Logger } from '../logger';

/**
 * US-009: the nax environment entry that points the exec helper at this job epoch's provider-key socket. A credential
 * provider without `serveProviderKeys` (a spec's acquire/release fake, or a runner that wired no provider vault) adds
 * nothing, so nax's own credentials file keeps serving — and being unable to serve is not a start failure: a job that
 * runs without koda keys behaves exactly as it did before the vault existed, while a job that lost its socket later
 * makes the helper fail loudly (design §5.4).
 */
export async function serveProviderSocket(
  credentials: CredentialProvider,
  job: JobRow,
  log: Logger,
): Promise<Readonly<Record<string, string>>> {
  const serve = credentials.serveProviderKeys;
  if (!serve) return {};
  try {
    return { [PROVIDER_CRED_SOCKET_ENV]: await serve.call(credentials, job) };
  } catch (error) {
    log.warn('provider-key socket unavailable', { jobId: job.jobId, error: errorMessage(error) });
    return {};
  }
}

/**
 * US-009: close this epoch's provider-key socket and drop its grants. Independent of the git release (the caller runs
 * both), and a failure only warns: it must never replace the error that ended the job or skip the cleanup after it.
 */
export async function releaseProviderSocket(credentials: CredentialProvider, job: JobRow, log: Logger): Promise<void> {
  const release = credentials.releaseProviderKeys;
  if (!release) return;
  try {
    await release.call(credentials, job);
  } catch (error) {
    log.warn('provider-key socket could not be released', { jobId: job.jobId, error: errorMessage(error) });
  }
}
