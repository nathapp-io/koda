import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMock } from '@golevelup/ts-vitest';
import { mockAuditRecorder } from '../common/test-helpers/global-stubs.module';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import type { AuditRecorder } from '../audit/audit-recorder.service';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { SkillsService } from './skills.service';
import type { SkillCatalogRepository } from './skill-catalog.domain';
import { SkillResolveError, type SkillResolver } from './skill-resolver';
import { ConflictAppException } from '../common/exceptions/conflict-app.exception';
import type { SkillSourceDomain } from './skill-catalog.domain';

const catalog = createMock<SkillCatalogRepository>();
const resolver = createMock<SkillResolver>();

describe('SkillsService.createSource', () => {
  let service: SkillsService;

  beforeEach(() => {
    vi.resetAllMocks();
    catalog.findSource.mockResolvedValue(null);
    catalog.findSkillOwners.mockResolvedValue([]);
    catalog.createSource.mockImplementation(async (input) => ({
      ...input, id: 'source-1', createdAt: new Date(),
      skills: input.skills.map((skill, index) => ({ ...skill, id: `skill-${index}` })),
    }));
    resolver.resolve.mockResolvedValue({ sha: 'sha-1', skills: [] });
    service = new SkillsService(catalog, resolver, mockAuditRecorder);
  });

  const input = { gitUrl: 'https://github.com/acme/skills', ref: 'main', path: 'skills' };
  const principal: KodaPrincipal = { actorType: 'agent', id: 'agent-1', name: 'Agent', slug: 'agent', status: 'ACTIVE', agentRoles: [], capabilities: [], blacklisted: false, revoked: false, authorities: [] };
  const source: SkillSourceDomain = { ...input, id: 'source-1', owner: 'acme', repo: 'skills', createdById: principal.id, resolvedSha: 's1', resolvedAt: new Date(), createdAt: new Date(), status: 'OK', statusReason: null, skills: [] };

  it('AC-8: resolves once before create callback, never during it', async () => {
    const apply = await service.prepareCreateSource(input, principal);
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
    expect(catalog.createSource).not.toHaveBeenCalled();
    await apply();
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
    expect(catalog.createSource).toHaveBeenCalledTimes(1);
  });

  it('AC-9: rechecks source existence after preparation', async () => {
    const apply = await service.prepareCreateSource(input, principal);
    catalog.findSource.mockResolvedValue(source);
    await expect(apply()).rejects.toBeInstanceOf(ConflictAppException);
    await expect(apply()).rejects.toMatchObject({ prefix: 'skills.sourceExists' });
    expect(catalog.createSource).not.toHaveBeenCalled();
  });

  it('AC-10: rechecks name ownership after create preparation', async () => {
    resolver.resolve.mockResolvedValue({ sha: 's2', skills: [{ name: 'taken', description: '', dir: '.' }] });
    const apply = await service.prepareCreateSource(input, principal);
    catalog.findSkillOwners.mockResolvedValue([{ name: 'taken', source }]);
    await expect(apply()).rejects.toBeInstanceOf(ConflictAppException);
    await expect(apply()).rejects.toMatchObject({ prefix: 'skills.nameConflict', args: { name: 'taken', gitUrl: source.gitUrl } });
    expect(catalog.createSource).not.toHaveBeenCalled();
  });

  it('AC-11: rechecks source existence after update preparation', async () => {
    catalog.findSourceById.mockResolvedValue(source);
    resolver.resolve.mockResolvedValue({ sha: 's2', skills: [{ name: 'updated', description: '', dir: '.' }] });
    const apply = await service.prepareUpdateSource(source.id);
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
    catalog.findSourceById.mockResolvedValue(null);
    await expect(apply()).rejects.toBeInstanceOf(NotFoundAppException);
    await expect(apply()).rejects.toMatchObject({ prefix: 'skills.sourceNotFound' });
    expect(catalog.replaceSourceSkills).not.toHaveBeenCalled();
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
  });

  it('AC-12: rechecks other name owners after update preparation', async () => {
    catalog.findSourceById.mockResolvedValue(source);
    resolver.resolve.mockResolvedValue({ sha: 's2', skills: [{ name: 'taken', description: '', dir: '.' }] });
    const apply = await service.prepareUpdateSource(source.id);
    catalog.findSkillOwners.mockResolvedValue([{ name: 'taken', source: { ...source, id: 'other' } }]);
    await expect(apply()).rejects.toBeInstanceOf(ConflictAppException);
    await expect(apply()).rejects.toMatchObject({ prefix: 'skills.nameConflict', args: { name: 'taken', gitUrl: source.gitUrl } });
    expect(catalog.replaceSourceSkills).not.toHaveBeenCalled();
  });

  it('preserves empty-resolution update failure without replacing skills', async () => {
    catalog.findSourceById.mockResolvedValue(source);
    catalog.markResolveFailed.mockResolvedValue({ ...source, status: 'RESOLVE_FAILED' });
    const apply = await service.prepareUpdateSource(source.id);
    expect(catalog.markResolveFailed).not.toHaveBeenCalled();
    await expect(apply()).resolves.toMatchObject({ status: 'RESOLVE_FAILED' });
    expect(catalog.markResolveFailed).toHaveBeenCalledExactlyOnceWith(source.id, 'no_skills');
    expect(catalog.replaceSourceSkills).not.toHaveBeenCalled();
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
  });

  it('rechecks missing source even after a known resolution failure', async () => {
    catalog.findSourceById.mockResolvedValue(source);
    resolver.resolve.mockRejectedValue(new SkillResolveError('ref_not_found'));
    const apply = await service.prepareUpdateSource(source.id);
    catalog.findSourceById.mockResolvedValue(null);
    await expect(apply()).rejects.toMatchObject({ prefix: 'skills.sourceNotFound' });
    expect(catalog.markResolveFailed).not.toHaveBeenCalled();
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
