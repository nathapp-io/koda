import { ValidationAppException } from '@nathapp/nestjs-common';
import { validateCreateWorkspaceThread, type CreateWorkspaceThreadInput } from './thread-input';
const raw = (over: Record<string, unknown> = {}) => ({ title: 't', backend: { kind: 'native' }, ...over }) as CreateWorkspaceThreadInput;
describe('workspace input', () => {
  it.each([
    ['AC-1', { kind: 'PROJECT' }, 'kind'],
    ['AC-2', { repoId: 'r1' }, 'workspaceFields'],
    ['AC-3', { backend: { kind: 'acp', agent: 'claude' } }, 'backend'],
    ['AC-4', { homeProject: 42 }, 'homeProject'],
    ['feature', { feature: '' }, 'workspaceFields'],
    ['baseRef', { baseRef: 'main' }, 'workspaceFields'],
    ['empty home', { homeProject: '' }, 'homeProject'],
    ['long home', { homeProject: 'a'.repeat(101) }, 'homeProject'],
    ['title', { title: '\n' }, 'title'],
    ['cost', { maxCostUsd: 0 }, 'maxCostUsd'],
    ['backend extras', { backend: { kind: 'native', secret: true } }, 'backend'],
    ['order', { kind: 'REPO', repoId: 'r', homeProject: 4, title: '' }, 'kind'],
  ])('%s rejects with the documented reason', (_name, over, reason) => {
    try { validateCreateWorkspaceThread(raw(over)); throw new Error('accepted invalid input'); }
    catch (error) { expect(error).toBeInstanceOf(ValidationAppException); expect(error).toMatchObject({ prefix: 'threads.input', httpStatus: 400, args: { reason } }); }
  });
  it('normalizes null fields and defaults', () => {
    expect(validateCreateWorkspaceThread(raw({ homeProject: null, repoId: null, feature: null, baseRef: null }))).toEqual({ kind: 'WORKSPACE', title: 't', backend: { kind: 'native' }, maxCostUsd: '5' });
  });
});
