import { ProjectAssigneesService } from './project-assignees.service';
import { AssigneeQuery } from './dto/assignee.query';
import { IProjectAssigneesRepository } from './domain/project-assignee.domain';

const repositoryWith = (rows: Awaited<ReturnType<IProjectAssigneesRepository['search']>>) => {
  const search = vi.fn().mockResolvedValue(rows);
  const service = new ProjectAssigneesService({ search } as unknown as IProjectAssigneesRepository);
  return { service, search };
};

describe('ProjectAssigneesService', () => {
  it('passes the validated q and limit through to the repository', async () => {
    const { service, search } = repositoryWith([]);

    await service.search('proj-1', AssigneeQuery.parse({ q: '  ALI  ', limit: '2' }));

    expect(search).toHaveBeenCalledWith('proj-1', 'ALI', 2);
  });

  it('defaults to the no-filter query', async () => {
    const { service, search } = repositoryWith([]);

    await service.search('proj-1', AssigneeQuery.parse({}));

    expect(search).toHaveBeenCalledWith('proj-1', '', 20);
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
