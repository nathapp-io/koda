import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import type { ThreadBackend } from '../common/thread-jobs';
import type { ChatThreadRepository, ThreadServeNeed } from './domain/chat-thread.domain';

/** The backend field a refusal names, and the value the caller asked for. */
function refusalArgs(backend: ThreadBackend): { field: string; value: string } {
  if (backend.kind === 'acp') return { field: 'backend.agent', value: backend.agent };
  if (backend.model !== undefined) return { field: 'backend.model', value: backend.model };
  return { field: 'backend.kind', value: 'native' };
}

/**
 * #399, US-001 (#424): a thread no enabled thread-capable runner can host would queue its first turn forever,
 * because placement skips it and records nothing. Thread create refuses it instead (409), naming the cause: the
 * backend, the thread kind's hosting capability, or the mode's capability.
 *
 * A fleet with no thread-capable runner at all is not judged (see `threadServeMisfit`).
 */
export async function assertThreadServed(threads: Pick<ChatThreadRepository, 'threadServeMisfit'>, need: ThreadServeNeed): Promise<void> {
  const misfit = await threads.threadServeMisfit(need);
  if (misfit === null) return;
  switch (misfit) {
    case 'thread_backend':
      throw new ConflictAppException(refusalArgs(need.backend), 'threads.backendUnavailable');
    case 'project_threads':
      throw new ConflictAppException({}, 'threads.projectThreadsUnavailable');
    case 'workspace_threads':
      throw new ConflictAppException({}, 'threads.workspaceThreadsUnavailable');
    case 'thread_modes':
      throw new ConflictAppException({ mode: need.mode }, 'threads.modeUnavailable');
    default:
      // A session need never reaches the write rule, and no other cause exists.
      throw new Error('unexpected thread misfit');
  }
}
