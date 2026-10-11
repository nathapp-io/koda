import { buildThreadInstructions } from './thread-instructions';
import type { ThreadSkillSource } from '../../skills/skill-catalog.domain';

const source: ThreadSkillSource = {
  sourceId: 'source-1', owner: 'acme', repo: 'app', sha: 'resolved-sha',
  skills: [{ name: 'spec-review', dir: 'skills/spec-review', description: 'Review a spec' }],
};
const input = {
  repo: 'acme/app', baseRef: 'main', feature: 'add-auth',
  specPath: '.nax/features/add-auth/spec.md', skills: [source],
};

describe('buildThreadInstructions (US-004)', () => {
  it('AC1: renders each available skill as a load_skill entry', () => {
    expect(buildThreadInstructions(input).split('\n')).toContain('- spec-review — Review a spec');
  });

  it('AC2: includes the requested spec path', () => {
    expect(buildThreadInstructions(input)).toContain('.nax/features/add-auth/spec.md');
  });

  it('AC3: tells the agent to put the spec draft in its reply', () => {
    expect(buildThreadInstructions(input)).toContain('Put the spec draft in your reply.');
  });

  it('AC4: reports no skills on the final line when the snapshot is empty', () => {
    expect(buildThreadInstructions({ ...input, skills: [] }).split('\n').at(-1)).toBe('Skills available: none.');
  });
});
