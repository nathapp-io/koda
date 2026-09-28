jest.mock('./factory', () => ({ createVcsProvider: jest.fn() }));
jest.mock('../common/utils/encryption.util', () => ({ decryptToken: jest.fn().mockReturnValue('plain') }));

import { createVcsProvider } from './factory';
import { VcsLinkExtractorService } from './vcs-link-extractor.service';
import type { PrismaVcsRepository } from './prisma-vcs.repository';
import type { VcsConnectionDomain } from './domain/vcs.domain';

describe('VcsLinkExtractorService PR number (VCS LOW)', () => {
  it('asks the provider for the PR it was given, never /pulls/0', async () => {
    const getPullRequestStatus = jest.fn().mockResolvedValue({ number: 12 });
    (createVcsProvider as jest.Mock).mockReturnValue({ getPullRequestStatus, listPrCommits: jest.fn().mockResolvedValue([]) });
    const service = new VcsLinkExtractorService({ upsertTicketLink: jest.fn() } as unknown as PrismaVcsRepository);

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
