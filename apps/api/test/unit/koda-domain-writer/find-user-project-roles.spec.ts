import { PrismaKodaDomainWriterRepository } from '../../../src/koda-domain-writer/prisma-koda-domain-writer.repository';

/** One `RoleBinding` row as `legacy-membership.queries.ts` selects it. */
const bindingRow = (key: string, projectId: string | null) => ({
  projectId,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  grantedByType: 'SYSTEM',
  grantedById: 'test',
  role: { key, scope: 'PROJECT' },
});

/**
 * Permissions P1b US-003 (#145): the writer's roles are the union of the global `User.role`, the
 * legacy `ProjectMember` row and the user's compatibility `userProjectRole`. The binding reads the
 * compatibility query makes are stubbed here, so a role can come from a binding alone.
 */
describe('#145 findUserProjectRoles', () => {
  function setup(
    options: { membershipRole?: string | null; bindingKeys?: string[] } = {},
  ) {
    let releaseUser: (value: { role: string } | null) => void = () => undefined;
    const membershipRole = options.membershipRole === undefined ? 'DEVELOPER' : options.membershipRole;
    const prismaMock = {
      client: {
        user: {
          findUnique: vi.fn(() => new Promise((resolve) => { releaseUser = resolve; })),
        },
        projectMember: {
          findUnique: vi.fn(async () => (membershipRole === null ? null : { role: membershipRole })),
        },
        roleBinding: {
          findMany: vi.fn(async () =>
            (options.bindingKeys ?? []).map((key) => bindingRow(key, 'p1')),
          ),
        },
      },
    };
    const repo = new PrismaKodaDomainWriterRepository(prismaMock as never);
    return { repo, prismaMock, release: (value: { role: string } | null) => releaseUser(value) };
  }

  it('starts the membership lookup without waiting for the user lookup', async () => {
    const { repo, prismaMock, release } = setup({ bindingKeys: ['developer'] });
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

  it('returns no roles for an unknown user with no membership and no binding', async () => {
    const { repo, release } = setup({ membershipRole: null, bindingKeys: [] });
    const pending = repo.findUserProjectRoles('p1', 'ghost');
    release(null);
    await expect(pending).resolves.toEqual([]);
  });

  it('adds the binding role for a user whose only source in the project is a binding', async () => {
    const { repo, release } = setup({ membershipRole: null, bindingKeys: ['developer'] });
    const pending = repo.findUserProjectRoles('p1', 'u1');
    release({ role: 'MEMBER' });
    await expect(pending).resolves.toEqual(['DEVELOPER']);
  });

  it('de-duplicates a binding role the legacy row already carries', async () => {
    const { repo, release } = setup({ membershipRole: 'DEVELOPER', bindingKeys: ['developer'] });
    const pending = repo.findUserProjectRoles('p1', 'u1');
    release({ role: 'MEMBER' });
    await expect(pending).resolves.toEqual(['DEVELOPER']);
  });

  it('keeps a legacy AGENT row raw alongside the strongest binding role', async () => {
    const { repo, release } = setup({ membershipRole: 'AGENT', bindingKeys: ['viewer'] });
    const pending = repo.findUserProjectRoles('p1', 'u1');
    release({ role: 'MEMBER' });
    await expect(pending).resolves.toEqual(['AGENT', 'VIEWER']);
  });
});
