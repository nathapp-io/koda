import type { SkillResolveReason } from './skill-resolver';

export const SKILL_CATALOG_REPOSITORY = Symbol('SKILL_CATALOG_REPOSITORY');

export interface SkillDomain {
  id: string;
  name: string;
  description: string;
  dir: string;
}

export interface SkillSourceDomain {
  id: string;
  gitUrl: string;
  owner: string;
  repo: string;
  ref: string;
  path: string;
  resolvedSha: string | null;
  resolvedAt: Date | null;
  status: 'OK' | 'RESOLVE_FAILED';
  statusReason: string | null;
  createdAt: Date;
  skills: SkillDomain[];
}

export interface SkillCatalogRepository {
  findSource(owner: string, repo: string, ref: string, path: string): Promise<SkillSourceDomain | null>;
  findSkillOwner(name: string): Promise<SkillSourceDomain | null>;
  createSource(input: Omit<SkillSourceDomain, 'id' | 'createdAt' | 'skills'> & { createdById: string; skills: Array<Omit<SkillDomain, 'id'>> }): Promise<SkillSourceDomain>;
  listSources(): Promise<SkillSourceDomain[]>;
}

export function formatSkillResolveReason(reason: SkillResolveReason, detail?: string): string {
  return (detail ? `${reason}:${detail}` : reason).slice(0, 300);
}
