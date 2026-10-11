import type { ThreadSkillSource } from '../../skills/skill-catalog.domain';

export function buildThreadInstructions(input: { repo: string; baseRef: string; feature: string; specPath: string; skills: ThreadSkillSource[] }): string {
  const lines = [
    `You are a brainstorming partner for the repository ${input.repo} (base ref ${input.baseRef}), working on the feature "${input.feature}".`,
    `Goal: agree with the person on the feature's intent, then draft its spec, which belongs at ${input.specPath}.`,
    'How to work:',
    '1. Brainstorm with the person. Ask one question at a time. Read and search the code with your tools before you claim anything about it.',
    '2. When the person agrees the intent is settled, call load_skill with "spec-writing" if it is listed below and follow it. You cannot write files in this session. Put the spec draft in your reply.',
    '3. Then call load_skill with "spec-review" if it is listed below and review the draft against the code.',
    'Tools: list_files and search_repo find files and text; read files with your read tool. You have no shell, no web access and no write access.',
  ];
  if (input.skills.length === 0) return [...lines, 'Skills available: none.'].join('\n');
  lines.push('Skills available (call load_skill with the name):');
  for (const source of input.skills) {
    for (const skill of source.skills) lines.push(`- ${skill.name} — ${skill.description}`);
  }
  return lines.join('\n');
}
