import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { ProjectSkillRouteCommands, PROJECT_SKILL_ROUTE_VARIANTS } from './project-skill-route.commands';
import { ProjectSkillDto } from './dto/project-skill.dto';

describe('ProjectSkillRouteCommands', () => {
  const setup = () => {
    const registry = new ApprovalCommandRegistry();
    const result = { id: 's1', name: 'skill', description: '', enabled: true, source: { id: 'src', gitUrl: 'https://github.com/a/b', ref: 'main', resolvedSha: null, status: 'OK' } };
    const skills = { enableProjectSkill: vi.fn().mockResolvedValue(result), disableProjectSkill: vi.fn().mockResolvedValue(undefined) };
    const loader = { forContext: vi.fn().mockResolvedValue({ type: 'USER', id: 'u1' }) };
    new ProjectSkillRouteCommands(registry, skills as never, loader as never).onModuleInit();
    return { registry, skills, result };
  };
  it.each([['skill.project.enable', 'enable'], ['skill.project.disable', 'disable']] as const)('AC-9: registers %s', (key, name) => {
    const { registry } = setup();
    expect(registry.get(key, PROJECT_SKILL_ROUTE_VARIANTS[name])).toMatchObject({ key, variant: `rest:project-skills.${name}` });
  });
  it('AC-10: enables as the rebuilt user and maps the DTO/result', async () => {
    const { registry, skills, result } = setup();
    const command = registry.get('skill.project.enable', PROJECT_SKILL_ROUTE_VARIANTS.enable);
    if (!command || !command.toResult) throw new Error('Missing enable command');
    const input = command.parse({ slug: 'alpha', projectId: 'p1', skillId: 's1' });
    const output = await command.execute(input);
    expect(skills.enableProjectSkill).toHaveBeenCalledExactlyOnceWith('p1', 's1', 'u1');
    expect(output).toBeInstanceOf(ProjectSkillDto);
    expect(command.toResult(output)).toEqual(result);
    expect(() => command.parse({ slug: 'alpha', projectId: '', skillId: 's1' })).toThrow();
  });
  it('disables without a stored result and propagates missing targets', async () => {
    const { registry, skills } = setup();
    const command = registry.get('skill.project.disable', PROJECT_SKILL_ROUTE_VARIANTS.disable);
    if (!command) throw new Error('Missing disable command');
    const input = command.parse({ slug: 'alpha', projectId: 'p1', skillId: 's1' });
    expect(await command.execute(input)).toBeNull();
    expect(skills.disableProjectSkill).toHaveBeenCalledExactlyOnceWith('p1', 's1');
    expect(command.toResult).toBeUndefined();
    skills.disableProjectSkill.mockRejectedValue(new Error('missing'));
    await expect(command.execute(input)).rejects.toThrow('missing');
  });
});
