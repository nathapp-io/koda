import { describe, expect, it, vi } from 'vitest';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { assertBackendServed } from './thread-backend-served';

const repo = (served: boolean) => ({ anyRunnerServesBackend: vi.fn(async () => served) });

async function refusal(served: boolean, backend: Parameters<typeof assertBackendServed>[1]) {
  const threads = repo(served);
  const error = await assertBackendServed(threads, backend).then(() => null, (e: unknown) => e);
  return { threads, error };
}

describe('assertBackendServed (#399)', () => {
  it('passes when some enabled runner serves the backend, asking with the backend as given', async () => {
    const { threads, error } = await refusal(true, { kind: 'native', model: 'opencode-go/deepseek-v4.1-flash' });
    expect(error).toBeNull();
    expect(threads.anyRunnerServesBackend).toHaveBeenCalledWith({ kind: 'native', model: 'opencode-go/deepseek-v4.1-flash' });
  });

  it('refuses a native model no runner offers with 409 threads.backendUnavailable naming backend.model', async () => {
    const { error } = await refusal(false, { kind: 'native', model: 'deepseek/deepseek-v4.1-flash-1017' });
    expect(error).toBeInstanceOf(ConflictAppException);
    expect(error).toMatchObject({ code: 409, prefix: 'threads.backendUnavailable', args: { field: 'backend.model', value: 'deepseek/deepseek-v4.1-flash-1017' } });
  });

  it('refuses an ACP agent no runner offers naming backend.agent', async () => {
    const { error } = await refusal(false, { kind: 'acp', agent: 'cursor' });
    expect(error).toMatchObject({ code: 409, prefix: 'threads.backendUnavailable', args: { field: 'backend.agent', value: 'cursor' } });
  });

  it('refuses a native backend without a model (no runner offers any native model) naming backend.kind', async () => {
    const { error } = await refusal(false, { kind: 'native' });
    expect(error).toMatchObject({ code: 409, prefix: 'threads.backendUnavailable', args: { field: 'backend.kind', value: 'native' } });
  });
});
