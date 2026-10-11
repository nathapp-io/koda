import { PrismaKodaDomainWriterRepository } from '../../../src/koda-domain-writer/prisma-koda-domain-writer.repository';

describe('#145 findUserProjectRoles', () => {
  function setup() {
    let releaseUser: (value: { role: string } | null) => void = () => undefined;
    const prismaMock = {
      client: {
        user: {
          findUnique: vi.fn(() => new Promise((resolve) => { releaseUser = resolve; })),
        },
        projectMember: {
          findUnique: vi.fn(async () => ({ role: 'DEVELOPER' })),
        },
      },
    };
    const repo = new PrismaKodaDomainWriterRepository(prismaMock as never);
    return { repo, prismaMock, release: (value: { role: string } | null) => releaseUser(value) };
  }

  it('starts the membership lookup without waiting for the user lookup', async () => {
    const { repo, prismaMock, release } = setup();
    const pending = repo.findUserProjectRoles('p1', 'u1');
    await Promise.resolve();
    expect(prismaMock.client.projectMember.findUnique).toHaveBeenCalledWith({
      where: { projectId_userId: { projectId: 'p1', userId: 'u1' } },
      select: { role: true },
    });
    release({ role: 'ADMIN' });
    await expect(pending).resolves.toEqual(['ADMIN', 'DEVELOPER']);
  });

  it('returns only the membership role for a non-admin user', async () => {
    const { repo, release } = setup();
    const pending = repo.findUserProjectRoles('p1', 'u1');
    release({ role: 'MEMBER' });
    await expect(pending).resolves.toEqual(['DEVELOPER']);
  });

  it('returns no roles for an unknown user with no membership', async () => {
    const { repo, prismaMock, release } = setup();
    prismaMock.client.projectMember.findUnique.mockResolvedValueOnce(null as never);
    const pending = repo.findUserProjectRoles('p1', 'ghost');
    release(null);
    await expect(pending).resolves.toEqual([]);
  });
});
