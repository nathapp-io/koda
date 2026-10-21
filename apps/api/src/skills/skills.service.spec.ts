import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMock } from '@golevelup/ts-vitest';
import type { ITransactionManager } from '@nathapp/nestjs-data';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { SkillsService } from './skills.service';
import type { SkillCatalogRepository } from './skill-catalog.domain';
import type { SkillResolver } from './skill-resolver';

const catalog = createMock<SkillCatalogRepository>();
const resolver = createMock<SkillResolver>();
const txManager: ITransactionManager = {
  run: vi.fn((fn) => fn()),
  getClient: vi.fn(),
  isInTransaction: vi.fn(() => false),
};

describe('SkillsService.createSource', () => {
  let service: SkillsService;

  beforeEach(() => {
    vi.clearAllMocks();
    catalog.findSource.mockResolvedValue(null);
    catalog.findSkillOwners.mockResolvedValue([]);
    catalog.createSource.mockImplementation(async (input) => ({
      ...input, id: 'source-1', createdAt: new Date(),
      skills: input.skills.map((skill, index) => ({ ...skill, id: `skill-${index}` })),
    }));
    resolver.resolve.mockResolvedValue({ sha: 'sha-1', skills: [] });
    service = new SkillsService(catalog, resolver, txManager);
  });

  it('allows agent principals and records their id as creator', async () => {
    const principal: KodaPrincipal = {
      actorType: 'agent', id: 'agent-123', name: 'Skill Agent', slug: 'skill-agent',
      status: 'ACTIVE', agentRoles: [], capabilities: [],
      blacklisted: false, revoked: false, authorities: [],
    };

    await service.createSource({ gitUrl: 'https://github.com/acme/skills', ref: 'main', path: 'skills' }, principal);

    expect(catalog.createSource).toHaveBeenCalledWith(expect.objectContaining({ createdById: 'agent-123' }));
  });
});
