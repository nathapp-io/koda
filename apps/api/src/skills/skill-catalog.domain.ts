import type { SkillResolveReason } from './skill-resolver';

export const SKILL_CATALOG_REPOSITORY = Symbol('SKILL_CATALOG_REPOSITORY');

export interface SkillDomain {
  id: string;
  name: string;
  description: string;
  dir: string;
}

export interface ProjectSkillDomain {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  source: Pick<SkillSourceDomain, 'id' | 'gitUrl' | 'ref' | 'resolvedSha' | 'status'>;
}

export interface SkillSourceDomain {
  id: string;
  gitUrl: string;
  owner: string;
  repo: string;
  ref: string;
  path: string;
  createdById: string;
  resolvedSha: string | null;
  resolvedAt: Date | null;
  status: 'OK' | 'RESOLVE_FAILED';
  statusReason: string | null;
  createdAt: Date;
  skills: SkillDomain[];
}

export interface SkillCatalogRepository {
  findSource(owner: string, repo: string, ref: string, path: string): Promise<SkillSourceDomain | null>;
  findSourceById(id: string): Promise<SkillSourceDomain | null>;
  findSkillOwner(name: string): Promise<SkillSourceDomain | null>;
  findSkillOwners(names: string[]): Promise<Array<{ name: string; source: SkillSourceDomain }>>;
  replaceSourceSkills(id: string, input: { resolvedSha: string; resolvedAt: Date; skills: Array<Omit<SkillDomain, 'id'>> }): Promise<SkillSourceDomain | null>;
  markResolveFailed(id: string, statusReason: string): Promise<SkillSourceDomain | null>;
  deleteSource(id: string): Promise<boolean>;
  createSource(input: Omit<SkillSourceDomain, 'id' | 'createdAt' | 'skills'> & { createdById: string; skills: Array<Omit<SkillDomain, 'id'>> }): Promise<SkillSourceDomain>;
  listSources(): Promise<SkillSourceDomain[]>;
  listProjectSkills(projectId: string): Promise<ProjectSkillDomain[]>;
  enableProjectSkill(projectId: string, skillId: string, userId: string): Promise<ProjectSkillDomain | null>;
  disableProjectSkill(skillId: string, projectId: string): Promise<boolean>;
}

export function formatSkillResolveReason(reason: SkillResolveReason, detail?: string): string {
  return Array.from(detail ? `${reason}:${detail}` : reason).slice(0, 300).join('');
}
