import { ToolInputError } from '../assistant-tool.types';
import { dispatchJobTool, type DispatchJobInput } from './dispatch-job-tool';
import type { FleetJobsService } from '../../jobs/fleet-jobs.service';
import type { KnowledgeIndexService } from '../../knowledge/knowledge-index.service';
import type { KnowledgeRepoRef } from '../../knowledge/knowledge-index.domain';
import type { ToolContext } from '../assistant-tool.types';

const ctx = { projectId: 'p1', projectSlug: 'web', actor: { id: 'dev-1', actorType: 'user' } } as ToolContext;
const repo: KnowledgeRepoRef = { id: 'r1', projectId: 'p1', provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', githubInstallationId: null };
function setup(provider = 'github') {
  const dispatch = vi.fn(async () => ({ job: { id: 'j1', state: 'QUEUED' } }));
  const resolveProjectRepo = vi.fn(async () => ({ ...repo, provider } as KnowledgeRepoRef));
  return { dispatch, tool: dispatchJobTool({ dispatch } as unknown as FleetJobsService, { resolveProjectRepo } as unknown as KnowledgeIndexService) };
}
async function refused(tool: ReturnType<typeof setup>['tool'], input: DispatchJobInput, reason: string) {
  try { await tool.preview?.(ctx, input); } catch (error) { expect(error).toBeInstanceOf(ToolInputError); expect((error as ToolInputError).reason).toBe(reason); return; }
  throw new Error('expected refusal');
}
describe('dispatch job PR preview and DTO', () => {
  it('AC-1: previews FIX in specified order', async () => {
    const { tool } = setup();
    expect(await tool.preview?.(ctx, { repo: 'acme/app', command: 'FIX', prNumber: 23, maxCostUsd: 1, profiles: ['native-codex'] })).toBe('Dispatch FIX in web:\nrepo: acme/app @ main\npull request: #23\nmax cost: $1\nprofiles: native-codex');
  });
  it.each([['FIX', 'fix is GitHub-only'], ['REVIEW', 'review is GitHub-only']] as const)('AC-2: refuses GitLab %s', async (command, reason) => {
    const { tool } = setup('gitlab'); await refused(tool, { repo: 'acme/app', command, prNumber: 23, maxCostUsd: 1 }, reason);
  });
  it.each([
    [{ command: 'REVIEW', feature: 'x' }, 'feature is derived for REVIEW'],
    [{ command: 'REVIEW', ref: 'dev' }, 'ref is the default branch for REVIEW'],
    [{ command: 'RUN', feature: 'login', prNumber: 23 }, 'prNumber is only for REVIEW and FIX'],
    [{ command: 'FIX', feature: 'x' }, 'feature is derived for FIX'],
  ] as const)('refuses invalid cross-fields', async (fields, reason) => {
    const { tool } = setup(); await refused(tool, { repo: 'acme/app', maxCostUsd: 1, prNumber: 23, ...fields } as DispatchJobInput, reason);
  });
  it('AC-6: dispatches FIX DTO with PR number and no feature', async () => {
    const { tool, dispatch } = setup();
    await tool.execute(ctx, { repo: 'acme/app', command: 'FIX', prNumber: 23, maxCostUsd: 1, profiles: ['native-codex'] });
    expect(dispatch.mock.calls[0]?.[2]).toEqual({ repoId: 'r1', command: 'FIX', prNumber: 23, maxCostUsd: 1, profiles: ['native-codex'] });
  });
  it('AC-13: keeps PLAN preview unchanged', async () => {
    const { tool } = setup();
    expect(await tool.preview?.(ctx, { repo: 'acme/app', command: 'PLAN', feature: 'add-auth', planFrom: 'docs/spec.md', maxCostUsd: 0.5 })).toBe('Dispatch PLAN in web:\nrepo: acme/app @ main\nfeature: add-auth\nmax cost: $0.5\nplan from: docs/spec.md');
  });
  it('AC-14: keeps RUN DTO without absent PR number', async () => {
    const { tool, dispatch } = setup();
    await tool.execute(ctx, { repo: 'acme/app', command: 'RUN', feature: 'add-auth', maxCostUsd: 0.5 });
    expect(dispatch.mock.calls[0]?.[2]).toEqual({ repoId: 'r1', command: 'RUN', feature: 'add-auth', maxCostUsd: 0.5 });
    expect('prNumber' in (dispatch.mock.calls[0]?.[2] as object)).toBe(false);
  });
});
