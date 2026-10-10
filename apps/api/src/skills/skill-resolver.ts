export interface ResolvedSkill {
  name: string;
  description: string;
  dir: string;
}

export interface SkillResolution {
  sha: string;
  skills: ResolvedSkill[];
}

export type SkillResolveReason =
  | 'not_public_or_missing'
  | 'ref_not_found'
  | 'rate_limited'
  | 'tree_truncated'
  | 'no_skills'
  | 'too_many_skills'
  | 'invalid_skill'
  | 'duplicate_name'
  | 'provider_error'
  | 'provider_unreachable';

export class SkillResolveError extends Error {
  constructor(
    readonly reason: SkillResolveReason,
    readonly detail?: string,
  ) {
    super(reason);
  }
}

export interface SkillResolver {
  resolve(input: { owner: string; repo: string; ref: string; path: string }): Promise<SkillResolution>;
}

export const SKILL_RESOLVER = Symbol('SKILL_RESOLVER');
