import { Inject, Injectable } from '@nestjs/common';
import { AbstractPrismaRepository, PrismaClientLike, PrismaModelDelegate, PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { PrismaClient, SkillSource as SkillSourceModel } from '../generated/prisma/client';
import type { SkillCatalogRepository, SkillDomain, SkillSourceDomain } from './skill-catalog.domain';

@Injectable()
export class PrismaSkillCatalogRepository extends AbstractPrismaRepository<SkillSourceDomain, SkillSourceModel, string> implements SkillCatalogRepository {
  constructor(
    @Inject(TRANSACTION_MANAGER) tx: ITransactionManager,
    private readonly prisma: PrismaService<PrismaClient>,
  ) { super(tx); }

  protected modelDelegate(client: PrismaClientLike): PrismaModelDelegate<SkillSourceModel, string> {
    return (client as unknown as PrismaClient).skillSource as unknown as PrismaModelDelegate<SkillSourceModel, string>;
  }

  protected toDomain(model: SkillSourceModel): SkillSourceDomain {
    return { ...model, status: model.status as SkillSourceDomain['status'], skills: [] };
  }

  protected toPersistenceCreate(domain: SkillSourceDomain): Omit<SkillSourceModel, 'id' | 'createdAt' | 'updatedAt'> {
    return {
      gitUrl: domain.gitUrl, owner: domain.owner, repo: domain.repo, ref: domain.ref, path: domain.path,
      resolvedSha: domain.resolvedSha, resolvedAt: domain.resolvedAt, status: domain.status,
      statusReason: domain.statusReason, createdById: domain.createdById,
    };
  }

  protected toPersistenceUpdate(patch: Partial<SkillSourceDomain>): Partial<Omit<SkillSourceModel, 'id' | 'createdAt' | 'updatedAt'>> {
    return { status: patch.status, statusReason: patch.statusReason, resolvedSha: patch.resolvedSha, resolvedAt: patch.resolvedAt };
  }

  async findSource(owner: string, repo: string, ref: string, path: string): Promise<SkillSourceDomain | null> {
    const source = await this.prisma.client.skillSource.findUnique({ where: { owner_repo_ref_path: { owner, repo, ref, path } } });
    return source ? this.toDomain(source) : null;
  }

  async findSkillOwner(name: string): Promise<SkillSourceDomain | null> {
    const skill = await this.prisma.client.skill.findUnique({ where: { name }, include: { source: true } });
    return skill ? this.toDomain(skill.source) : null;
  }

  async createSource(input: Omit<SkillSourceDomain, 'id' | 'createdAt' | 'skills'> & { createdById: string; skills: Array<Omit<SkillDomain, 'id'>> }): Promise<SkillSourceDomain> {
    const source = await this.prisma.client.skillSource.create({
      data: {
        gitUrl: input.gitUrl, owner: input.owner, repo: input.repo, ref: input.ref, path: input.path,
        resolvedSha: input.resolvedSha, resolvedAt: input.resolvedAt, status: input.status,
        statusReason: input.statusReason, createdById: input.createdById,
        skills: { create: input.skills },
      },
      include: { skills: { orderBy: { name: 'asc' } } },
    });
    return { ...this.toDomain(source), skills: source.skills };
  }

  async listSources(): Promise<SkillSourceDomain[]> {
    const sources = await this.prisma.client.skillSource.findMany({
      take: 200,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { skills: { orderBy: { name: 'asc' } } },
    });
    return sources.map((source) => ({ ...this.toDomain(source), skills: source.skills }));
  }
}
