import { Logger } from '@nestjs/common';
import { PrismaRoleBindingRepository } from './prisma-role-binding.repository';
import { MEMBERSHIP_READ_CAP } from './membership.queries';

describe('PrismaRoleBindingRepository.findCandidatePrincipalIds', () => {
  const setup = (rows: { principalId: string }[]) => {
    const findMany = vi.fn().mockResolvedValue(rows);
    const repository = new PrismaRoleBindingRepository({} as never, { client: { roleBinding: { findMany } } } as never);
    return { repository, findMany };
  };
  it('uses scoped PROJECT bindings or null-project selected GLOBAL roles, sorted, distinct and capped', async () => {
    const { repository, findMany } = setup([{ principalId: 'a' }, { principalId: 'b' }]);
    expect(await repository.findCandidatePrincipalIds('AGENT', 'p1', ['global'])).toEqual(['a', 'b']);
    expect(findMany).toHaveBeenCalledExactlyOnceWith({
      where: { principalType: 'AGENT', OR: [
        { projectId: 'p1', role: { scope: 'PROJECT' } },
        { projectId: null, role: { scope: 'PROJECT' } },
        { projectId: null, roleId: { in: ['global'] } },
      ] },
      select: { principalId: true }, distinct: ['principalId'], orderBy: { principalId: 'asc' }, take: MEMBERSHIP_READ_CAP,
    });
  });
  it('answers the capped first page and warns with context when the read is full', async () => {
    const rows = Array.from({ length: MEMBERSHIP_READ_CAP }, (_, i) => ({ principalId: String(i) }));
    const { repository } = setup(rows);
    const warn = vi.spyOn(Logger.prototype, 'warn');
    warn.mockClear();
    expect(await repository.findCandidatePrincipalIds('USER', 'p1', [])).toEqual(rows.map(({ principalId }) => principalId));
    expect(warn).toHaveBeenCalledExactlyOnceWith(`findCandidatePrincipalIds read its ${MEMBERSHIP_READ_CAP}-row cap for USER in project p1 and answered the first page`);
  });
  it('propagates database errors unchanged', async () => {
    const { repository, findMany } = setup([]);
    const error = new Error('db');
    findMany.mockRejectedValueOnce(error);
    await expect(repository.findCandidatePrincipalIds('USER', 'p1', [])).rejects.toBe(error);
  });
});
