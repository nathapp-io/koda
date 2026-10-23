import { PermissionService } from '../../permissions/permission.service';
import { ProjectAssigneesService } from './project-assignees.service';
import { AssigneeQuery } from './dto/assignee.query';
import { IProjectAssigneesRepository } from './domain/project-assignee.domain';

const repositoryWith = (rows: Awaited<ReturnType<IProjectAssigneesRepository['search']>>) => {
  const search = vi.fn().mockResolvedValue(rows);
  const principalIdsWithKey = vi.fn(async (type: string, projectId: string, key: string) =>
    projectId === 'proj-1' && key === 'project.read' ? (type === 'USER' ? ['u1'] : type === 'AGENT' ? ['a1'] : []) : []);
  const service = new ProjectAssigneesService(
    { search } as unknown as IProjectAssigneesRepository,
    { principalIdsWithKey } as unknown as PermissionService,
  );
  return { service, search, principalIdsWithKey };
};

describe('ProjectAssigneesService', () => {
  it('AC-15: enumerates both principal types by project.read and passes ids as argument four', async () => {
    const { service, search, principalIdsWithKey } = repositoryWith([]);
    await service.search('proj-1', AssigneeQuery.parse({ q: 'a', limit: 10 }));
    expect(principalIdsWithKey.mock.calls).toEqual([
      ['USER', 'proj-1', 'project.read'], ['AGENT', 'proj-1', 'project.read'],
    ]);
    expect(search).toHaveBeenCalledExactlyOnceWith('proj-1', 'a', 10, { userIds: ['u1'], agentIds: ['a1'] });
  });
  it('does not read assignee details if enumeration fails', async () => {
    const { service, search, principalIdsWithKey } = repositoryWith([]);
    const error = new Error('read failed');
    principalIdsWithKey.mockRejectedValueOnce(error);
    await expect(service.search('proj-1', AssigneeQuery.parse({}))).rejects.toBe(error);
    expect(search).not.toHaveBeenCalled();
  });
  it('passes the validated q and limit through to the repository', async () => {
    const { service, search } = repositoryWith([]);

    await service.search('proj-1', AssigneeQuery.parse({ q: '  ALI  ', limit: '2' }));

    expect(search).toHaveBeenCalledWith('proj-1', 'ALI', 2, { userIds: ['u1'], agentIds: ['a1'] });
  });

  it('defaults to the no-filter query', async () => {
    const { service, search } = repositoryWith([]);

    await service.search('proj-1', AssigneeQuery.parse({}));

    expect(search).toHaveBeenCalledWith('proj-1', '', 20, { userIds: ['u1'], agentIds: ['a1'] });
  });

  it('maps users and agents to the DTO, keeping users-first order and the agent status', async () => {
    const { service } = repositoryWith([
      { type: 'user', id: 'u1', name: 'Alice', secondary: 'alice@koda.test' },
      { type: 'agent', id: 'a1', name: 'alias-bot', secondary: 'alias-bot', status: 'PAUSED' },
    ]);

    const result = await service.search('proj-1', AssigneeQuery.parse({}));

    expect(result.items).toEqual([
      { type: 'user', id: 'u1', name: 'Alice', secondary: 'alice@koda.test' },
      { type: 'agent', id: 'a1', name: 'alias-bot', secondary: 'alias-bot', status: 'PAUSED' },
    ]);
  });

  it('never sets a status on a user entry', async () => {
    const { service } = repositoryWith([
      { type: 'user', id: 'u1', name: 'Alice', secondary: 'alice@koda.test' },
    ]);

    const [user] = (await service.search('proj-1', AssigneeQuery.parse({}))).items;

    expect(user).not.toHaveProperty('status');
  });
});
