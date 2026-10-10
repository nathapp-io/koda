import { Inject, Injectable } from '@nestjs/common';
import { ConflictAppException } from '../common/exceptions/conflict-app.exception';
import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { parseGitHubUrl } from './github-url';
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
      for (const skill of resolution.skills) {
        const owner = await this.catalog.findSkillOwner(skill.name);
        if (owner) throw new ConflictAppException({ name: skill.name, gitUrl: owner.gitUrl }, 'skills.nameConflict');
      }
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
    } catch (error) {
      if (!(error instanceof SkillResolveError)) throw error;
      return this.txManager.run(() => this.catalog.markResolveFailed(id, formatSkillResolveReason(error.reason, error.detail)));
    }

    for (const skill of resolution.skills) {
      const owner = await this.catalog.findSkillOwner(skill.name);
      if (owner && owner.id !== id) {
        throw new ConflictAppException({ name: skill.name, gitUrl: owner.gitUrl }, 'skills.nameConflict');
      }
    }

    return this.txManager.run(() => this.catalog.replaceSourceSkills(id, {
      resolvedSha: resolution.sha,
      resolvedAt: new Date(),
      skills: resolution.skills,
    }));
  }

  async deleteSource(id: string): Promise<void> {
    const deleted = await this.txManager.run(() => this.catalog.deleteSource(id));
    if (!deleted) throw new NotFoundAppException({}, 'skills.sourceNotFound');
  }

  listSources(): Promise<SkillSourceDomain[]> {
    return this.catalog.listSources();
  }
}
