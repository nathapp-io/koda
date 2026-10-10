import type { Mock } from 'vitest';
vi.mock('./factory', () => ({ createVcsProvider: vi.fn() }));
vi.mock('../common/utils/encryption.util', () => ({ decryptToken: vi.fn().mockReturnValue('plain') }));

import { createVcsProvider } from './factory';
import { VcsLinkExtractorService } from './vcs-link-extractor.service';
import type { PrismaVcsRepository } from './prisma-vcs.repository';
import type { VcsConnectionDomain } from './domain/vcs.domain';

describe('VcsLinkExtractorService PR number (VCS LOW)', () => {
  it('asks the provider for the PR it was given, never /pulls/0', async () => {
    const getPullRequestStatus = vi.fn().mockResolvedValue({ number: 12 });
    (createVcsProvider as Mock).mockReturnValue({ getPullRequestStatus, listPrCommits: vi.fn().mockResolvedValue([]) });
    const service = new VcsLinkExtractorService({ upsertTicketLink: vi.fn() } as unknown as PrismaVcsRepository);

    await service.extractLinksFromPr(
      { id: 'p1', key: 'P' },
      { id: 't1', number: 3, externalVcsId: 'acme/widgets#99' },
      { provider: 'github', repoOwner: 'acme', repoName: 'widgets', encryptedToken: 'enc' } as VcsConnectionDomain,
      'ab'.repeat(32),
      'feat/p-3',
      12,
    );

    expect(getPullRequestStatus).toHaveBeenCalledWith(12);
  });
});
