import { parseSkillFrontmatter } from './skill-frontmatter';
import { SkillResolveError } from './skill-resolver';

const FRONTMATTER = ['---', 'name: spec-review', 'description: "Review a spec"', '---', '# Body'].join('\n');

/** Returns what `fn` threw, or undefined when it returned normally. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

function expectInvalidSkill(text: string): void {
  const error = thrownBy(() => parseSkillFrontmatter(text));
  expect(error).toBeInstanceOf(SkillResolveError);
  expect((error as SkillResolveError).reason).toBe('invalid_skill');
}

describe('parseSkillFrontmatter (US-001)', () => {
  it('AC-4: returns name and a double-quoted description with the quotes stripped', () => {
    expect(parseSkillFrontmatter(FRONTMATTER)).toEqual({ name: 'spec-review', description: 'Review a spec' });
  });

  it('AC-5: accepts CRLF line endings', () => {
    expect(parseSkillFrontmatter(FRONTMATTER.replace(/\n/g, '\r\n'))).toEqual({
      name: 'spec-review',
      description: 'Review a spec',
    });
  });

  it('AC-6: strips a leading UTF-8 BOM', () => {
    expect(parseSkillFrontmatter(`\uFEFF${FRONTMATTER}`)).toEqual({
      name: 'spec-review',
      description: 'Review a spec',
    });
  });

  it('AC-7: truncates a description longer than 1024 characters to 1024', () => {
    const long = 'd'.repeat(1500);
    const text = `---\nname: spec-review\ndescription: ${long}\n---\n`;
    expect(parseSkillFrontmatter(text).description).toBe(long.slice(0, 1024));
  });

  it('accepts single-quoted and unquoted scalars and ignores other keys', () => {
    const text = "---\nlicense: MIT\nname: 'spec-review'\ndescription: Review a spec\n---\n";
    expect(parseSkillFrontmatter(text)).toEqual({ name: 'spec-review', description: 'Review a spec' });
  });

  it('AC-8: rejects text whose first line is not "---" with invalid_skill', () => {
    expectInvalidSkill('# Title\n---\nname: spec-review\ndescription: x\n---\n');
  });

  it('rejects text with no closing "---" line with invalid_skill', () => {
    expectInvalidSkill('---\nname: spec-review\ndescription: Review a spec\n');
  });

  it('AC-9: rejects a name that is not lowercase kebab-case with invalid_skill', () => {
    expectInvalidSkill('---\nname: Spec_Review\ndescription: Review a spec\n---\n');
  });

  it('rejects a name longer than 64 characters with invalid_skill', () => {
    expectInvalidSkill(`---\nname: ${'a'.repeat(65)}\ndescription: Review a spec\n---\n`);
  });

  it('accepts a 64-character name', () => {
    const name = 'a'.repeat(64);
    expect(parseSkillFrontmatter(`---\nname: ${name}\ndescription: Review a spec\n---\n`).name).toBe(name);
  });

  it('AC-10: rejects a block-scalar description (">") with invalid_skill', () => {
    expectInvalidSkill('---\nname: spec-review\ndescription: >\n  Review a spec\n---\n');
  });

  it('rejects a block-scalar description ("|") with invalid_skill', () => {
    expectInvalidSkill('---\nname: spec-review\ndescription: |\n  Review a spec\n---\n');
  });

  it('AC-11: rejects a frontmatter with a name and no description with invalid_skill', () => {
    expectInvalidSkill('---\nname: spec-review\n---\n');
  });

  it('AC-12: rejects a description key with no value with invalid_skill', () => {
    expectInvalidSkill('---\nname: spec-review\ndescription:\n---\n');
  });

  it('rejects a frontmatter with no name key with invalid_skill', () => {
    expectInvalidSkill('---\ndescription: Review a spec\n---\n');
  });
});
