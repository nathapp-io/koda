import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMock } from '@golevelup/ts-vitest';
import { mockAuditRecorder } from '../common/test-helpers/global-stubs.module';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import type { AuditRecorder } from '../audit/audit-recorder.service';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { SkillsService } from './skills.service';
import type { SkillCatalogRepository } from './skill-catalog.domain';
import type { SkillResolver } from './skill-resolver';

const catalog = createMock<SkillCatalogRepository>();
const resolver = createMock<SkillResolver>();

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
    service = new SkillsService(catalog, resolver, mockAuditRecorder);
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

  it('AC13: does not record when enabling a missing skill', async () => {
    catalog.enableProjectSkill.mockResolvedValue(null);
    const record = vi.fn();
    const audited = vi.fn(async <T>(fn: () => Promise<T>, entriesOf: (result: T) => unknown) => {
      const result = await fn();
      entriesOf(result);
      return result;
    });
    const audit = { record, audited } as unknown as AuditRecorder;
    const missingSkillService = new SkillsService(catalog, resolver, audit);

    await expect(missingSkillService.enableProjectSkill('project-1', 'missing-skill', 'user-1'))
      .rejects.toBeInstanceOf(NotFoundAppException);
    expect(audited).toHaveBeenCalledTimes(1);
    expect(record).not.toHaveBeenCalled();
  });
});
