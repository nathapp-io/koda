import { Inject, Injectable } from '@nestjs/common';
import { ConflictAppException } from '../common/exceptions/conflict-app.exception';
import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { parseGitHubUrl } from './github-url';
import { isUniqueViolation } from '../common/utils/prisma-errors';
import { SKILL_CATALOG_REPOSITORY, SkillCatalogRepository, SkillSourceDomain, formatSkillResolveReason } from './skill-catalog.domain';
import { SKILL_RESOLVER, SkillResolver, SkillResolveError } from './skill-resolver';

@Injectable()
export class SkillsService {
  constructor(
    @Inject(SKILL_CATALOG_REPOSITORY) private readonly catalog: SkillCatalogRepository,
    @Inject(SKILL_RESOLVER) private readonly resolver: SkillResolver,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  async createSource(input: { gitUrl: string; ref: string; path: string }, principal: KodaPrincipal): Promise<SkillSourceDomain> {
    if (principal.actorType !== 'user') throw new ForbiddenAppException({}, 'skills.principal');
    const parsed = parseGitHubUrl(input.gitUrl);
    if (await this.catalog.findSource(parsed.owner, parsed.repo, input.ref, input.path)) {
      throw new ConflictAppException({}, 'skills.sourceExists');
    }

    let resolution: Awaited<ReturnType<SkillResolver['resolve']>> | undefined;
    let statusReason: string | null = null;
    try {
      resolution = await this.resolver.resolve({ owner: parsed.owner, repo: parsed.repo, ref: input.ref, path: input.path });
      const owners = await this.catalog.findSkillOwners(resolution.skills.map((skill) => skill.name));
      const taken = owners[0];
      if (taken) throw new ConflictAppException({ name: taken.name, gitUrl: taken.source.gitUrl }, 'skills.nameConflict');
    } catch (error) {
      if (error instanceof ConflictAppException) throw error;
      if (!(error instanceof SkillResolveError)) throw error;
      statusReason = formatSkillResolveReason(error.reason, error.detail);
    }

    return this.txManager.run(() => this.catalog.createSource({
      gitUrl: parsed.gitUrl,
      owner: parsed.owner,
      repo: parsed.repo,
      ref: input.ref,
      path: input.path,
      resolvedSha: resolution?.sha ?? null,
      resolvedAt: resolution ? new Date() : null,
      status: resolution ? 'OK' : 'RESOLVE_FAILED',
      statusReason,
      createdById: principal.id,
      skills: resolution?.skills ?? [],
    }));
  }

  async updateSource(id: string): Promise<SkillSourceDomain> {
    const source = await this.catalog.findSourceById(id);
    if (!source) throw new NotFoundAppException({}, 'skills.sourceNotFound');

    let resolution: Awaited<ReturnType<SkillResolver['resolve']>>;
    try {
      resolution = await this.resolver.resolve({ owner: source.owner, repo: source.repo, ref: source.ref, path: source.path });
      if (resolution.skills.length === 0) throw new SkillResolveError('no_skills');
    } catch (error) {
      if (!(error instanceof SkillResolveError)) throw error;
      const failed = await this.txManager.run(() => this.catalog.markResolveFailed(id, formatSkillResolveReason(error.reason, error.detail)));
      if (!failed) throw new NotFoundAppException({}, 'skills.sourceNotFound');
      return failed;
    }

    const owners = await this.catalog.findSkillOwners(resolution.skills.map((skill) => skill.name));
    const otherOwner = owners.find(({ source }) => source.id !== id);
    if (otherOwner) {
      throw new ConflictAppException({ name: otherOwner.name, gitUrl: otherOwner.source.gitUrl }, 'skills.nameConflict');
    }

    try {
      const updated = await this.txManager.run(() => this.catalog.replaceSourceSkills(id, {
        resolvedSha: resolution.sha,
        resolvedAt: new Date(),
        skills: resolution.skills,
      }));
      if (!updated) throw new NotFoundAppException({}, 'skills.sourceNotFound');
      return updated;
    } catch (error) {
      if (!isUniqueViolation(error, 'name')) throw error;
      const racedOwners = await this.catalog.findSkillOwners(resolution.skills.map((skill) => skill.name));
      const racedOwner = racedOwners.find(({ source }) => source.id !== id);
      if (!racedOwner) throw error;
      throw new ConflictAppException({ name: racedOwner.name, gitUrl: racedOwner.source.gitUrl }, 'skills.nameConflict');
    }
  }

  async deleteSource(id: string): Promise<void> {
    const deleted = await this.txManager.run(() => this.catalog.deleteSource(id));
    if (!deleted) throw new NotFoundAppException({}, 'skills.sourceNotFound');
  }

  listSources(): Promise<SkillSourceDomain[]> {
    return this.catalog.listSources();
  }

  listProjectSkills(projectId: string) {
    return this.catalog.listProjectSkills(projectId);
  }

  async enableProjectSkill(projectId: string, skillId: string, userId: string) {
    const skill = await this.catalog.enableProjectSkill(projectId, skillId, userId);
    if (!skill) throw new NotFoundAppException({}, 'skills.notFound');
    return skill;
  }

  async disableProjectSkill(projectId: string, skillId: string): Promise<void> {
    if (!await this.catalog.disableProjectSkill(projectId, skillId)) {
      throw new NotFoundAppException({}, 'skills.notFound');
    }
  }
}
