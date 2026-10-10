import type { Mock } from 'vitest';
/**
 * M12: a late pull_request delivery (fresh delivery id, so replay protection
 * lets it through) must not regress a merged link. The repository refuses the
 * write; the handler reports the delivery as ignored.
 */
import { VcsWebhookService, GitHubWebhookPayload } from './vcs-webhook.service';
import type { IVcsRepository, TicketLinkData } from './domain/vcs.repository';
import type { VcsConnectionWithProjectDomain } from './domain/vcs.domain';
import type { VcsSyncService } from './vcs-sync.service';
import type { VcsPrSyncService } from './vcs-pr-sync.service';
import type { IVcsConfig } from '../config/vcs.config';

const connection = {
  id: 'conn-1',
  projectId: 'proj-1',
  provider: 'github',
  repoOwner: 'acme',
  repoName: 'widgets',
  encryptedToken: 'enc',
  syncMode: 'webhook',
  allowedAuthors: '[]',
  pollingIntervalMs: 600000,
  webhookSecret: 'secret',
  isActive: true,
  lastSyncedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  project: { id: 'proj-1', key: 'ACME', slug: 'acme' },
} as VcsConnectionWithProjectDomain;

function link(prState: string | null): TicketLinkData {
  return {
    id: 'link-1',
    ticketId: 'ticket-1',
    prNumber: 7,
    prState,
    url: 'https://github.com/acme/widgets/pull/7',
    externalRef: 'acme/widgets#7',
    ticket: { id: 'ticket-1', status: 'VERIFY_FIX', projectId: 'proj-1', number: 1, externalVcsId: null },
  };
}

function payload(action: string, pr: Partial<NonNullable<GitHubWebhookPayload['pull_request']>> = {}): GitHubWebhookPayload {
  return {
    action,
    pull_request: {
      number: 7,
      title: 'PR',
      body: null,
      user: { login: 'dev' },
      html_url: 'https://github.com/acme/widgets/pull/7',
      state: 'open',
      draft: false,
      merged: false,
      merged_at: null,
      merged_by: null,
      base: { ref: 'main', repo: { full_name: 'acme/widgets' } },
      head: { ref: 'feat', repo: { full_name: 'acme/widgets' } },
      ...pr,
    },
  };
}

describe('VcsWebhookService — merged is terminal (M12)', () => {
  let repo: { findTicketLinkForConnectionPr: Mock; updateTicketLinkWithPrState: Mock };
  let prSync: { applyMergedPr: Mock };
  let service: VcsWebhookService;

  beforeEach(() => {
    repo = { findTicketLinkForConnectionPr: vi.fn(), updateTicketLinkWithPrState: vi.fn() };
    prSync = { applyMergedPr: vi.fn().mockResolvedValue('updated') };
    service = new VcsWebhookService(
      repo as unknown as IVcsRepository,
      {} as VcsSyncService,
      prSync as unknown as VcsPrSyncService,
      { encryptionKey: undefined, defaultPollingIntervalMs: 600000, githubApiUrl: 'https://api.github.com' } as IVcsConfig,
    );
  });

  afterEach(() => service.onModuleDestroy());

  it.each([
    ['opened', {}, 'open'],
    ['closed', { state: 'closed' }, 'closed'],
    ['ready_for_review', {}, 'open'],
    ['reopened', {}, 'open'],
    ['converted_to_draft', { draft: true }, 'draft'],
  ])('a late %s delivery on a merged link is ignored', async (action, pr, attempted) => {
    repo.findTicketLinkForConnectionPr.mockResolvedValue(link('merged'));
    repo.updateTicketLinkWithPrState.mockResolvedValue('already-merged');

    const result = await service.handleWebhook(connection, 'pull_request', payload(action, pr));

    expect(repo.updateTicketLinkWithPrState).toHaveBeenCalledWith('link-1', attempted);
    expect(result).toEqual({ success: true, ignored: true, reason: 'PR is already merged' });
  });

  it('reports a vanished link as missing, not as already merged', async () => {
    repo.findTicketLinkForConnectionPr.mockResolvedValue(link('open'));
    repo.updateTicketLinkWithPrState.mockResolvedValue('not-found');

    const result = await service.handleWebhook(connection, 'pull_request', payload('closed', { state: 'closed' }));

    expect(result).toEqual({ success: true, ignored: true, reason: 'TicketLink no longer exists' });
  });

  it('a duplicate merged delivery neither re-runs the transition nor rewrites the link', async () => {
    repo.findTicketLinkForConnectionPr.mockResolvedValue(link('merged'));

    const result = await service.handleWebhook(
      connection,
      'pull_request',
      payload('closed', { state: 'closed', merged: true, merged_at: '2026-09-28T00:00:00Z' }),
    );

    expect(prSync.applyMergedPr).not.toHaveBeenCalled();
    expect(repo.updateTicketLinkWithPrState).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, ignored: true, reason: 'PR is already merged' });
  });

  it('an open link still moves to merged', async () => {
    repo.findTicketLinkForConnectionPr.mockResolvedValue(link('open'));

    const result = await service.handleWebhook(
      connection,
      'pull_request',
      payload('closed', { state: 'closed', merged: true, merged_at: '2026-09-28T00:00:00Z' }),
    );

    expect(prSync.applyMergedPr).toHaveBeenCalledWith(link('open'), expect.objectContaining({ merged: true, url: 'https://github.com/acme/widgets/pull/7' }));
    expect(result).toEqual({ success: true, ignored: false });
  });

  it('reports a merge another path already recorded as already merged (D457)', async () => {
    repo.findTicketLinkForConnectionPr.mockResolvedValue(link('open'));
    prSync.applyMergedPr.mockResolvedValueOnce('already-merged');

    const result = await service.handleWebhook(
      connection,
      'pull_request',
      payload('closed', { state: 'closed', merged: true, merged_at: '2026-09-28T00:00:00Z' }),
    );

    expect(result).toEqual({ success: true, ignored: true, reason: 'PR is already merged' });
  });
});
