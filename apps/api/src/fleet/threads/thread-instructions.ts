import type { ThreadSkillSource } from '../../skills/skill-catalog.domain';

export function buildThreadInstructions(input: { repo: string; baseRef: string; feature: string; specPath: string; skills: ThreadSkillSource[] }): string {
  const lines = [
    `You are a brainstorming partner for the repository ${input.repo} (base ref ${input.baseRef}), working on the feature "${input.feature}".`,
    `Goal: agree with the person on the feature's intent, then draft its spec, which belongs at ${input.specPath}.`,
    'How to work:',
    '1. Brainstorm with the person. Ask one question at a time. Read and search the code with your tools before you claim anything about it.',
    `2. When the person agrees the intent is settled, call load_skill with "spec-writing" if it is listed below and follow it. Write the spec to ${input.specPath} with write_doc.`,
    '3. Then call load_skill with "spec-review" if it is listed below and review the draft against the code.',
    'Tools: list_files and search_repo find files and text; read files with your read tool; write_doc writes docs. You have no shell and no web access.',
    `write_doc writes Markdown (.md) files under docs/ and ${featureDir(input.feature)} only. Nothing is committed until the person presses Publish; tell them when a draft is ready to publish.`,
  ];
  return [...lines, ...skillLines(input.skills)].join('\n');
}

/**
 * The instructions of a PROJECT thread's turn (S5b-R3): the thread belongs to the project alone, so its agent gets the
 * project's name, no repository to read and no spec to draft. The skill block is the one `buildThreadInstructions`
 * renders, so both kinds list their skills identically.
 */
export function buildProjectThreadInstructions(input: { project: string; skills: ThreadSkillSource[] }): string {
  const lines = [
    `You are a brainstorming partner for the koda project "${input.project}". This thread is not tied to a repository.`,
    'Ask one question at a time. You have no repository, no shell and no web access; do not claim facts about code you cannot see.',
  ];
  return [...lines, ...skillLines(input.skills)].join('\n');
}

/** The "Skills available" block both thread kinds end with. */
function skillLines(skills: ThreadSkillSource[]): string[] {
  if (skills.length === 0) return ['Skills available: none.'];
  const lines = ['Skills available (call load_skill with the name):'];
  for (const source of skills) {
    for (const skill of source.skills) lines.push(`- ${skill.name} — ${skill.description}`);
  }
  return lines;
}

/** The feature folder write_doc may write under: `.nax/features/<feature>/` (spec §4). */
function featureDir(feature: string): string {
  return `.nax/features/${feature}/`;
}
