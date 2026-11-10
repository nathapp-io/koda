import { describe, expect, it, vi } from 'vitest';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { assertThreadServed } from './thread-backend-served';
import type { ThreadCapabilityMisfit } from '../jobs/placement-rules';
import type { ThreadServeNeed } from './domain/chat-thread.domain';

const repo = (misfit: ThreadCapabilityMisfit | null) => ({ threadServeMisfit: vi.fn(async () => misfit) });

const need = (over: Partial<ThreadServeNeed> = {}): ThreadServeNeed => ({
  backend: { kind: 'native', model: 'opencode-go/deepseek-v4.1-flash' }, kind: 'REPO', mode: 'read', ...over,
});

async function refusal(misfit: ThreadCapabilityMisfit | null, asked: ThreadServeNeed = need()) {
  const threads = repo(misfit);
  const error = await assertThreadServed(threads, asked).then(() => null, (e: unknown) => e);
  return { threads, error };
}

describe('assertThreadServed (#399, US-001)', () => {
  it('passes when some runner can host the thread, asking with the need as given', async () => {
    const { threads, error } = await refusal(null);
    expect(error).toBeNull();
    expect(threads.threadServeMisfit).toHaveBeenCalledWith({ backend: { kind: 'native', model: 'opencode-go/deepseek-v4.1-flash' }, kind: 'REPO', mode: 'read' });
  });

  it('refuses a native model no runner offers with 409 threads.backendUnavailable naming backend.model', async () => {
    const { error } = await refusal('thread_backend', need({ backend: { kind: 'native', model: 'deepseek/deepseek-v4.1-flash-1017' } }));
    expect(error).toBeInstanceOf(ConflictAppException);
    expect(error).toMatchObject({ code: 409, prefix: 'threads.backendUnavailable', args: { field: 'backend.model', value: 'deepseek/deepseek-v4.1-flash-1017' } });
  });

  it('refuses an ACP agent no runner offers naming backend.agent', async () => {
    const { error } = await refusal('thread_backend', need({ backend: { kind: 'acp', agent: 'cursor' } }));
    expect(error).toMatchObject({ code: 409, prefix: 'threads.backendUnavailable', args: { field: 'backend.agent', value: 'cursor' } });
  });

  it('refuses a native backend without a model (no runner offers any native model) naming backend.kind', async () => {
    const { error } = await refusal('thread_backend', need({ backend: { kind: 'native' } }));
    expect(error).toMatchObject({ code: 409, prefix: 'threads.backendUnavailable', args: { field: 'backend.kind', value: 'native' } });
  });

  it('AC-6: refuses a PROJECT thread no runner can host with 409 threads.projectThreadsUnavailable', async () => {
    const { error } = await refusal('project_threads', need({ kind: 'PROJECT' }));
    expect(error).toBeInstanceOf(ConflictAppException);
    expect(error).toMatchObject({ code: 409, prefix: 'threads.projectThreadsUnavailable' });
  });

  it('AC-7: refuses a WORKSPACE thread no runner can host with 409 threads.workspaceThreadsUnavailable', async () => {
    const { error } = await refusal('workspace_threads', need({ kind: 'WORKSPACE' }));
    expect(error).toBeInstanceOf(ConflictAppException);
    expect(error).toMatchObject({ code: 409, prefix: 'threads.workspaceThreadsUnavailable' });
  });

  it('AC-8: refuses a mode no runner can host with 409 threads.modeUnavailable naming the mode', async () => {
    const { error } = await refusal('thread_modes', need({ mode: 'full' }));
    expect(error).toBeInstanceOf(ConflictAppException);
    expect(error).toMatchObject({ code: 409, prefix: 'threads.modeUnavailable', args: { mode: 'full' } });
  });
});
