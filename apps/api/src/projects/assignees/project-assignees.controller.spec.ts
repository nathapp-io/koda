import { ProjectAssigneesController } from './project-assignees.controller';
import { ProjectAssigneesService } from './project-assignees.service';
import { AssigneeQuery } from './dto/assignee.query';
import { ProjectContext } from '../project-context';

const PROJECT: ProjectContext = { project: { id: 'proj-1', slug: 'koda' }, role: 'ADMIN' };

describe('ProjectAssigneesController', () => {
  const serviceWith = (items: unknown[]) => {
    const search = vi.fn().mockResolvedValue({ items });
    return {
      controller: new ProjectAssigneesController({ search } as unknown as ProjectAssigneesService),
      search,
    };
  };

  it('searches the guard-resolved project with the normalized query and wraps the items in the envelope', async () => {
    const item = { type: 'user', id: 'u1', name: 'Alice', secondary: 'alice@koda.test' };
    const { controller, search } = serviceWith([item]);

    const response = await controller.search({ q: ' ALI ' } as AssigneeQuery, PROJECT);

    expect(search).toHaveBeenCalledWith('proj-1', expect.objectContaining({ q: 'ALI', limit: 20 }));
    expect(response).toEqual({ ret: 0, data: { items: [item] } });
  });

  it('rejects an out-of-contract query before touching the service', async () => {
    const { controller, search } = serviceWith([]);

    await expect(controller.search({ limit: '51' } as unknown as AssigneeQuery, PROJECT)).rejects.toThrow();
    expect(search).not.toHaveBeenCalled();
  });
});
