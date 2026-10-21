import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillsService } from './skills.service';
import { SkillResolveError } from './skill-resolver';

const { catalog, resolver, txManager } = vi.hoisted(() => ({
  catalog: {
    findSource: vi.fn(),
    findSkillOwners: vi.fn(),
    createSource: vi.fn(),
  },
  resolver: { resolve: vi.fn() },
  txManager: { run: vi.fn((fn: () => Promise<unknown>) => fn()) },
}));

describe('SkillsService.createSource', () => {
  let service: SkillsService;

  beforeEach(() => {
    vi.clearAllMocks();
    catalog.findSource.mockResolvedValue(null);
    catalog.findSkillOwners.mockResolvedValue([]);
    catalog.createSource.mockImplementation(async (input) => input);
    resolver.resolve.mockResolvedValue({ sha: 'sha-1', skills: [] });
    service = new SkillsService(catalog, resolver, txManager as never);
  });

  it('allows agent principals and records their id as creator', async () => {
    const principal = { actorType: 'agent', id: 'agent-123' } as const;

    await service.createSource({ gitUrl: 'https://github.com/acme/skills', ref: 'main', path: 'skills' }, principal as never);

    expect(catalog.createSource).toHaveBeenCalledWith(expect.objectContaining({ createdById: 'agent-123' }));
  });
});
