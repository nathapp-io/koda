import { ProjectMembersController } from './project-members.controller';

describe('ProjectMembersController', () => {
  const service = { list: jest.fn(), add: jest.fn(), updateRole: jest.fn(), remove: jest.fn() };
  const controller = new ProjectMembersController(service as never);
  const principal = { actorType: 'user', id: 'u1' } as never;

  afterEach(() => jest.clearAllMocks());

  it('list parses paging strings and returns the six-field page', async () => {
    const page = { total: 0, current: 2, size: 5, hasNext: false, hasPrev: true, records: [] };
    service.list.mockResolvedValue(page);
    const res = await controller.list('proj', { current: '2', size: '5' } as never, principal);
    expect(service.list).toHaveBeenCalledWith('proj', principal, { current: 2, size: 5 });
    expect(res).toEqual(expect.objectContaining({ ret: 0, data: page }));
  });

  it('list ignores undeclared query keys', async () => {
    service.list.mockResolvedValue({ total: 0, current: 1, size: 20, hasNext: false, hasPrev: false, records: [] });
    await controller.list('proj', { projectId: 'other' } as never, principal);
    expect(service.list).toHaveBeenCalledWith('proj', principal, { current: 1, size: 20 });
  });

  it('remove returns an empty Ok', async () => {
    const res = await controller.remove('proj', 'u2', principal);
    expect(service.remove).toHaveBeenCalledWith('proj', 'u2', principal);
    expect(res).toEqual(expect.objectContaining({ ret: 0 }));
  });
});
