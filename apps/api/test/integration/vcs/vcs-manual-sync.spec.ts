import { ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalPending } from '../../../src/approvals/route/approval-pending';
import type { ApprovalRouteGate } from '../../../src/approvals/route/approval-route-gate';
import type { IVcsConfig } from '../../../src/config/vcs.config';
import type { ProjectsService } from '../../../src/projects/projects.service';
import type { VcsConnectionService } from '../../../src/vcs/vcs-connection.service';
import type { VcsPrSyncService } from '../../../src/vcs/vcs-pr-sync.service';
import { VcsController } from '../../../src/vcs/vcs.controller';

/** Legacy controller cases: provider and result construction now live in the manual-service unit spec. */
describe('VcsController manual sync delegation', () => {
  const ctx = { project: { id: 'p', slug: 'alpha' } };
  const summary = { syncType: 'manual', issuesSynced: 2, issuesSkipped: 1, tickets: [{ ref: 'ALPHA-4', title: 'Issue four' }] };
  let controller: VcsController;
  let config: IVcsConfig;
  let gate: { run: ReturnType<typeof vi.fn> };
  const projectLookup = vi.fn();
  beforeEach(() => {
    projectLookup.mockReset();
    config = { encryptionKey: 'key', githubApiUrl: '', gitlabApiUrl: '', defaultPollingIntervalMs: 300000 };
    gate = { run: vi.fn().mockResolvedValue({ status: 'executed', result: summary }) };
    controller = new VcsController({} as VcsConnectionService, {} as VcsPrSyncService,
      { findBySlug: projectLookup } as unknown as ProjectsService, config, gate as unknown as ApprovalRouteGate);
  });
  it.each(['single', 'all'] as const)('passes ctx to the %s issue gate and maps the executed body', async (kind) => {
    const result = kind === 'single' ? await controller.syncIssue('alpha', '7', ctx) : await controller.syncAll('alpha', ctx);
    expect(gate.run).toHaveBeenCalledExactlyOnceWith({
      key: kind === 'single' ? 'vcs.sync.issue' : 'vcs.sync.all',
      variant: kind === 'single' ? 'rest:vcs.sync-issue' : 'rest:vcs.sync-all',
      projectId: 'p', input: { slug: 'alpha', projectId: 'p', ...(kind === 'single' ? { issueNumber: '7' } : {}) },
    });
    expect(result.data).toBe(summary);
    expect(projectLookup).not.toHaveBeenCalled();
  });
  it.each(['single', 'all'] as const)('throws pending for %s', async (kind) => {
    gate.run.mockResolvedValue({ status: 'pending', request: { id: 'pending' } });
    await expect(kind === 'single' ? controller.syncIssue('alpha', '7', ctx) : controller.syncAll('alpha', ctx)).rejects.toThrow(ApprovalPending);
  });
  it.each(['single', 'all'] as const)('keeps the encryption check before the %s gate', async (kind) => {
    config.encryptionKey = null;
    await expect(kind === 'single' ? controller.syncIssue('alpha', '7', ctx) : controller.syncAll('alpha', ctx)).rejects.toThrow(ValidationAppException);
    expect(gate.run).not.toHaveBeenCalled();
  });
});
