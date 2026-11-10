import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import type { ThreadBackend } from '../common/thread-jobs';
import type { ChatThreadRepository } from './domain/chat-thread.domain';

/** The backend field a refusal names, and the value the caller asked for. */
function refusalArgs(backend: ThreadBackend): { field: string; value: string } {
  if (backend.kind === 'acp') return { field: 'backend.agent', value: backend.agent };
  if (backend.model !== undefined) return { field: 'backend.model', value: backend.model };
  return { field: 'backend.kind', value: 'native' };
}

/**
 * #399: a thread whose backend no enabled thread-capable runner advertises would queue its first turn forever, because
 * placement skips it with `thread_backend` and records nothing. Thread create refuses it instead (409), naming the
 * field. A fleet with no thread-capable runner at all is not judged (see `anyRunnerServesBackend`).
 */
export async function assertBackendServed(threads: Pick<ChatThreadRepository, 'anyRunnerServesBackend'>, backend: ThreadBackend): Promise<void> {
  if (await threads.anyRunnerServesBackend(backend)) return;
  throw new ConflictAppException(refusalArgs(backend), 'threads.backendUnavailable');
}
