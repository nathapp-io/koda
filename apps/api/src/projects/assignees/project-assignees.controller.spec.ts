import { ProjectAssigneesController } from './project-assignees.controller';
import { ProjectAssigneesService } from './project-assignees.service';
import { AssigneeQuery } from './dto/assignee.query';
import { ProjectContext } from '../project-context';
import { PERMISSION_KEY } from '@nathapp/nestjs-auth';
import { REQUIRES_METADATA, RequiresMetadata } from '../../permissions/requires.decorator';

const PROJECT: ProjectContext = { project: { id: 'proj-1', slug: 'koda' } };

describe('ProjectAssigneesController route permission metadata (US-007)', () => {
  it('search declares @Requires project.assignee.read and runs ProjectMembershipGuard first', () => {
    const fn = ProjectAssigneesController.prototype.search as unknown as object;

    expect(Reflect.getMetadata(REQUIRES_METADATA, fn) as RequiresMetadata).toEqual({
      keys: ['project.assignee.read'],
      mode: 'all',
      enforcedBy: 'guard',
    });
    const guards = (Reflect.getMetadata('__guards__', fn) ?? []) as unknown[];
    expect(guards.map((guard) => (guard as { name?: string }).name)).toEqual([
      'ProjectMembershipGuard',
      'RequiresGuard',
    ]);
    expect(Reflect.getMetadata(PERMISSION_KEY, fn)).toBeUndefined();
  });
});

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
