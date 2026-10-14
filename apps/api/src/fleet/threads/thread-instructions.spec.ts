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

  it('AC3: names write_doc and the spec path instead of asking for the draft in the reply', () => {
    const text = buildThreadInstructions(input);
    expect(text).toContain('write_doc');
    expect(text).toContain('.nax/features/add-auth/spec.md');
    expect(text).not.toContain('Put the spec draft in your reply.');
  });

  it('AC4: reports no skills on the final line when the snapshot is empty', () => {
    expect(buildThreadInstructions({ ...input, skills: [] }).split('\n').at(-1)).toBe('Skills available: none.');
  });

  it('AC-10: step 2 tells the agent to write the spec to the spec path with write_doc', () => {
    expect(buildThreadInstructions({ ...input, specPath: '.nax/features/add-auth/spec.md' }))
      .toContain('Write the spec to .nax/features/add-auth/spec.md with write_doc.');
  });

  it('AC-11: a line states what write_doc may write and that Publish commits it', () => {
    expect(buildThreadInstructions(input).split('\n')).toContain(
      'write_doc writes Markdown (.md) files under docs/ and .nax/features/add-auth/ only. Nothing is committed until the person presses Publish; tell them when a draft is ready to publish.',
    );
  });

  it('AC-12: the tools line lists write_doc and no longer says there is no write access', () => {
    const lines = buildThreadInstructions(input).split('\n');
    expect(lines).toContain(
      'Tools: list_files and search_repo find files and text; read files with your read tool; write_doc writes docs. You have no shell and no web access.',
    );
    expect(buildThreadInstructions(input)).not.toContain('no write access');
  });
});
