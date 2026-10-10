import { Inject, Injectable } from '@nestjs/common';
import { AbstractPrismaRepository, PrismaClientLike, PrismaModelDelegate, PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { PrismaClient, SkillSource as SkillSourceModel } from '../generated/prisma/client';
import type { ProjectSkillDomain, SkillCatalogRepository, SkillDomain, SkillSourceDomain } from './skill-catalog.domain';

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

  async findSourceById(id: string): Promise<SkillSourceDomain | null> {
    const source = await this.prisma.client.skillSource.findUnique({
      where: { id },
      include: { skills: { orderBy: { name: 'asc' } } },
    });
    return source ? { ...this.toDomain(source), skills: source.skills } : null;
  }

  async findSkillOwner(name: string): Promise<SkillSourceDomain | null> {
    const skill = await this.prisma.client.skill.findUnique({ where: { name }, include: { source: true } });
    return skill ? this.toDomain(skill.source) : null;
  }

  async findSkillOwners(names: string[]): Promise<Array<{ name: string; source: SkillSourceDomain }>> {
    if (names.length === 0) return [];
    const skills = await this.prisma.client.skill.findMany({
      where: { name: { in: names } },
      take: names.length,
      include: { source: true },
    });
    return skills.map((skill) => ({ name: skill.name, source: this.toDomain(skill.source) }));
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

  async replaceSourceSkills(
    id: string,
    input: { resolvedSha: string; resolvedAt: Date; skills: Array<Omit<SkillDomain, 'id'>> },
  ): Promise<SkillSourceDomain | null> {
    const lockedSource = await this.prisma.client.skillSource.updateMany({
      where: { id },
      data: { status: 'OK', statusReason: null, resolvedSha: input.resolvedSha, resolvedAt: input.resolvedAt },
    });
    if (lockedSource.count === 0) return null;

    const resolvedNames = input.skills.map((skill) => skill.name);
    const existing = resolvedNames.length === 0 ? [] : await this.prisma.client.skill.findMany({
      where: { sourceId: id, name: { in: resolvedNames } },
      take: resolvedNames.length,
    });
    const survivingNames = new Set(resolvedNames);
    await this.prisma.client.skill.deleteMany({ where: { sourceId: id, name: { notIn: [...survivingNames] } } });
    for (const skill of input.skills) {
      const current = existing.find((row) => row.name === skill.name);
      if (current) {
        await this.prisma.client.skill.update({ where: { id: current.id }, data: { description: skill.description, dir: skill.dir } });
      } else {
        await this.prisma.client.skill.create({ data: { sourceId: id, ...skill } });
      }
    }
    const source = await this.prisma.client.skillSource.findUnique({
      where: { id }, include: { skills: { orderBy: { name: 'asc' } } },
    });
    return source ? { ...this.toDomain(source), skills: source.skills } : null;
  }

  async markResolveFailed(id: string, statusReason: string): Promise<SkillSourceDomain | null> {
    const updated = await this.prisma.client.skillSource.updateMany({
      where: { id }, data: { status: 'RESOLVE_FAILED', statusReason },
    });
    if (updated.count === 0) return null;
    const source = await this.prisma.client.skillSource.findUnique({
      where: { id }, include: { skills: { orderBy: { name: 'asc' } } },
    });
    return source ? { ...this.toDomain(source), skills: source.skills } : null;
  }

  async deleteSource(id: string): Promise<boolean> {
    const result = await this.prisma.client.skillSource.deleteMany({ where: { id } });
    return result.count > 0;
  }

  async listSources(): Promise<SkillSourceDomain[]> {
    const sources = await this.prisma.client.skillSource.findMany({
      take: 200,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { skills: { orderBy: { name: 'asc' } } },
    });
    return sources.map((source) => ({ ...this.toDomain(source), skills: source.skills }));
  }

  async listProjectSkills(projectId: string): Promise<ProjectSkillDomain[]> {
    const skills = await this.prisma.client.skill.findMany({
      take: 10000,
      orderBy: { name: 'asc' },
      include: {
        source: true,
        projects: { where: { projectId }, select: { skillId: true } },
      },
    });
    return skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      enabled: skill.projects.length > 0,
      source: {
        id: skill.source.id,
        gitUrl: skill.source.gitUrl,
        ref: skill.source.ref,
        resolvedSha: skill.source.resolvedSha,
        status: skill.source.status as SkillSourceDomain['status'],
      },
    }));
  }

  async enableProjectSkill(projectId: string, skillId: string, userId: string): Promise<ProjectSkillDomain | null> {
    const skill = await this.prisma.client.skill.findUnique({ where: { id: skillId }, include: { source: true } });
    if (!skill) return null;
    await this.prisma.client.projectSkill.upsert({
      where: { projectId_skillId: { projectId, skillId } },
      create: { projectId, skillId, enabledById: userId },
      update: { enabledById: userId },
    });
    return {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      enabled: true,
      source: {
        id: skill.source.id,
        gitUrl: skill.source.gitUrl,
        ref: skill.source.ref,
        resolvedSha: skill.source.resolvedSha,
        status: skill.source.status as SkillSourceDomain['status'],
      },
    };
  }

  async disableProjectSkill(skillId: string, projectId: string): Promise<boolean> {
    const skill = await this.prisma.client.skill.findUnique({ where: { id: skillId } });
    if (!skill) return false;
    await this.prisma.client.projectSkill.deleteMany({ where: { projectId, skillId } });
    return true;
  }
}
